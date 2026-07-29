/**
 * Native-side counterpart of the mini-app's `nfc.ts` bridge client.
 *
 * Contract (channel = "mfe-nfc"):
 *   request  (mini app -> host):  { channel, id, action, payload }
 *   response (host -> mini app):  { channel, id, ok, data, error }
 *
 * action: 'isSupported' | 'read' | 'write' | 'cancel'
 *   isSupported -> data: { supported: boolean }
 *   read        -> data: { messages: [{ records: [{ type, payload }] }], tagInfo: { uid } }
 *   write       <- payload: { records: [{ type, payload }] }
 *   cancel      -> aborts an in-flight request by `id`, no response required
 *
 * IMPORTANT: the mini app calls `window.parent.postMessage(...)`, which
 * assumes it's running inside an <iframe>. Inside a React Native WebView the
 * page is top-level, so `window.parent === window` and the message never
 * reaches native. `postMessageShim` below monkey-patches `window.postMessage`
 * before the page loads so it's routed to `window.ReactNativeWebView.postMessage`
 * instead. Inject it via `injectedJavaScriptBeforeContentLoaded`.
 */

import type { TagEvent } from "react-native-nfc-manager";

function lazyNfc() {
  try {
    const mod = require("react-native-nfc-manager");
    return {
      NfcManager: mod.default ?? mod,
      Ndef: mod.Ndef,
    };
  } catch {
    return null;
  }
}

export const NFC_BRIDGE_CHANNEL = "mfe-nfc";

export const postMessageShim = `
  (function () {
    if (window.__nfcBridgeShimmed) return true;
    window.__nfcBridgeShimmed = true;
    var originalPostMessage = window.postMessage.bind(window);
    window.postMessage = function (message) {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        try {
          window.ReactNativeWebView.postMessage(JSON.stringify(message));
        } catch (e) {}
      } else {
        originalPostMessage(message);
      }
    };
  })();
  true;
`;

export const networkLogShim = `
(function () {
  if (window.__networkShimmed) return true;
  window.__networkShimmed = true;
  window.__networkBlocked = false;

  // IndexedDB network cache
  var DB_NAME = '__network_cache';
  var STORE_NAME = 'responses';
  var _db = null;
  function cacheDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve, reject) {
      var req = window.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
      };
      req.onsuccess = function () { _db = req.result; resolve(_db); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function cachePut(key, data) {
    cacheDB().then(function (db) {
      var tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ key: key, data: data, ts: Date.now() });
    }).catch(function () {});
  }

  function cacheGet(key) {
    return cacheDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, 'readonly');
        var req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = function () { resolve(req.result ? req.result.data : null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function send(method, url, status, statusText, duration, body) {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      try {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          channel: "__network__",
          method: method,
          url: (url && url.substring) ? url.substring(0, 500) : String(url),
          status: status,
          statusText: statusText,
          duration: duration,
          body: body ? String(body).substring(0, 1000) : ''
        }));
      } catch (e) {}
    }
  }

  // Intercept fetch
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (url, opts) {
      var reqUrl = typeof url === 'string' ? url : (url && url.url ? url.url : String(url));
      var method = (opts && opts.method) || 'GET';

      if (window.__networkBlocked) {
        return cacheGet(reqUrl).then(function (cached) {
          if (cached) {
            send('CACHED', reqUrl, cached.status, cached.statusText || '', 0, cached.body);
            return new Response(cached.body, {
              status: cached.status,
              statusText: cached.statusText || '',
              headers: cached.headers || {}
            });
          }
          send('MISS', reqUrl, 0, 'CACHE_MISS', 0, '');
          return Promise.reject(new TypeError('Failed to fetch'));
        });
      }

      var start = Date.now();
      return origFetch.apply(window, arguments).then(function (res) {
        var ct = res.headers && res.headers.get ? (res.headers.get('content-type') || '') : '';
        var clone = res.clone();
        if (ct.indexOf('json') >= 0 || ct.indexOf('text') >= 0) {
          return clone.text().then(function (body) {
            var dur = Date.now() - start;
            send(method, reqUrl, res.status, res.statusText, dur, body);
            var headers = {};
            if (res.headers && res.headers.forEach) {
              res.headers.forEach(function (v, k) { headers[k] = v; });
            }
            cachePut(reqUrl, { body: body, status: res.status, statusText: res.statusText, headers: headers });
            return res;
          }).catch(function () {
            send(method, reqUrl, res.status, res.statusText, Date.now() - start, '');
            return res;
          });
        }
        send(method, reqUrl, res.status, res.statusText, Date.now() - start, '[' + (ct || 'binary') + ']');
        return res;
      }).catch(function (err) {
        send(method, reqUrl, 0, err.message, Date.now() - start, '');
        throw err;
      });
    };
  }

  // Intercept XMLHttpRequest
  var origXHR = window.XMLHttpRequest;
  if (origXHR) {
    window.XMLHttpRequest = function () {
      var xhr = new origXHR();
      var start, method, url;

      var origOpen = xhr.open;
      xhr.open = function (m, u) {
        method = m;
        url = u;
        return origOpen.apply(xhr, arguments);
      };

      var origSend = xhr.send;
      xhr.send = function () {
        if (window.__networkBlocked) {
          cacheGet(url).then(function (cached) {
            if (cached) {
              send('CACHED', url, cached.status, cached.statusText || '', 0, cached.body);
              try { Object.defineProperty(xhr, 'responseText', { value: cached.body, configurable: true }); } catch (e) {}
              try { Object.defineProperty(xhr, 'response', { value: cached.body, configurable: true }); } catch (e) {}
              try { Object.defineProperty(xhr, 'status', { value: cached.status, configurable: true }); } catch (e) {}
              try { Object.defineProperty(xhr, 'statusText', { value: cached.statusText || '', configurable: true }); } catch (e) {}
              try { Object.defineProperty(xhr, 'readyState', { value: 4, configurable: true }); } catch (e) {}
              setTimeout(function () {
                try { xhr.dispatchEvent(new Event('readystatechange')); } catch (e) {}
                try { xhr.dispatchEvent(new Event('load')); } catch (e) {}
                try { xhr.dispatchEvent(new Event('loadend')); } catch (e) {}
                try { if (xhr.onload) xhr.onload(new Event('load')); } catch (e) {}
                try { if (xhr.onloadend) xhr.onloadend(new Event('loadend')); } catch (e) {}
              }, 0);
            } else {
              send('MISS', url, 0, 'CACHE_MISS', 0, '');
              setTimeout(function () {
                try { xhr.dispatchEvent(new Event('error')); } catch (e) {}
                try { if (xhr.onerror) xhr.onerror(new Event('error')); } catch (e) {}
              }, 0);
            }
          }).catch(function () {
            setTimeout(function () {
              try { xhr.dispatchEvent(new Event('error')); } catch (e) {}
              try { if (xhr.onerror) xhr.onerror(new Event('error')); } catch (e) {}
            }, 0);
          });
          return;
        }

        start = Date.now();
        xhr.addEventListener('loadend', function () {
          var body = xhr.responseText || xhr.response || '';
          send(method, url, xhr.status, xhr.statusText, Date.now() - start, body);
          if (xhr.status >= 200 && xhr.status < 400) {
            var headers = {};
            try {
              var h = xhr.getAllResponseHeaders();
              if (h) h.split('\\r\\n').forEach(function (l) {
                var p = l.indexOf(':');
                if (p > 0) headers[l.substring(0, p).trim().toLowerCase()] = l.substring(p + 1).trim();
              });
            } catch (e) {}
            cachePut(url, { body: body, status: xhr.status, statusText: xhr.statusText, headers: headers });
          }
        });
        return origSend.apply(xhr, arguments);
      };

      return xhr;
    };
  }

  // Intercept WebSocket
  var origWS = window.WebSocket;
  if (origWS) {
    window.WebSocket = function (url, protocols) {
      if (window.__networkBlocked) {
        send('BLOCKED', 'WS:' + url, 0, 'Network offline', 0, '');
        throw new Error('Network offline');
      }
      return new origWS(url, protocols);
    };
  }
})();
true;
`;

export const indexedDBDumpScript = `
(function () {
  try {
    if (!window.indexedDB || !window.indexedDB.databases) {
      window.ReactNativeWebView.postMessage(JSON.stringify({channel: "__indexeddb__", error: "indexedDB.databases() not supported"}));
      return;
    }
    window.indexedDB.databases().then(function(list) {
      var results = [];
      var pending = list.length;
      if (pending === 0) {
        window.ReactNativeWebView.postMessage(JSON.stringify({channel: "__indexeddb__", data: []}));
        return;
      }
      list.forEach(function(info) {
        var req = window.indexedDB.open(info.name);
        req.onsuccess = function() {
          var db = req.result;
          var entry = {name: db.name, version: db.version, stores: []};
          var names = [];
          for (var i = 0; i < db.objectStoreNames.length; i++) names.push(db.objectStoreNames[i]);
          var sp = names.length;
          if (sp === 0) {
            results.push(entry);
            pending--;
            if (pending === 0) try { window.ReactNativeWebView.postMessage(JSON.stringify({channel: "__indexeddb__", data: results})); } catch(e) {}
            db.close();
            return;
          }
          names.forEach(function(sn) {
            var tx = db.transaction(sn, "readonly");
            var store = tx.objectStore(sn);
            var allReq = store.getAll();
            allReq.onsuccess = function() {
              entry.stores.push({name: sn, records: allReq.result});
              sp--;
              if (sp === 0) {
                results.push(entry);
                pending--;
                if (pending === 0) try { window.ReactNativeWebView.postMessage(JSON.stringify({channel: "__indexeddb__", data: results})); } catch(e) {}
                db.close();
              }
            };
          });
        };
      });
    }).catch(function(err) {
      try { window.ReactNativeWebView.postMessage(JSON.stringify({channel: "__indexeddb__", error: err.message})); } catch(e) {}
    });
  } catch(err) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify({channel: "__indexeddb__", error: err.message})); } catch(e) {}
  }
})();
true;
`;

export const clearIndexedDBScript = `
(function () {
  if (!window.indexedDB || !window.indexedDB.databases) return;
  window.indexedDB.databases().then(function(list) {
    list.forEach(function(info) {
      if (info.name.indexOf('__network_') === 0) return;
      window.indexedDB.deleteDatabase(info.name);
    });
  });
})();
true;
`;

export const clearNetworkCacheScript = `
(function () {
  if (!window.indexedDB) return;
  try { window.indexedDB.deleteDatabase('__network_cache'); } catch(e) {}
})();
true;
`;

export const consoleLogShim = `
  (function () {
    if (window.__consoleShimmed) return true;
    window.__consoleShimmed = true;
    var cons = window.console;
    if (!cons) cons = {};
    function forward(level) {
      var orig = cons[level] || function() {};
      cons[level] = function () {
        var args = Array.prototype.slice.call(arguments);
        orig.apply(cons, args);
        if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
          try {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              channel: "__console__",
              level: level,
              args: args.map(function (a) {
                try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
                catch (e) { return String(a); }
              })
            }));
          } catch (e) {}
        }
      };
    }
    forward('log');
    forward('warn');
    forward('error');
  })();
  true;
`;

type NfcAction = "read" | "write" | "isSupported" | "cancel";

export type BridgeRequest = {
  channel: typeof NFC_BRIDGE_CHANNEL;
  id: string;
  action: NfcAction;
  payload?: unknown;
};

export type BridgeResponse = {
  channel: typeof NFC_BRIDGE_CHANNEL;
  id: string;
  ok?: boolean;
  data?: unknown;
  error?: string;
};

type NdefRecordWire = {
  type: string;
  payload: string | number[];
};

type ReadResultWire = {
  messages: { records: NdefRecordWire[] }[];
  tagInfo?: { uid?: string };
};

type WritePayload = {
  records: NdefRecordWire[];
};

/** Builds the JS injected into the WebView to dispatch a response back as a `message` event. */
export function buildResponseInjection(response: BridgeResponse): string {
  return `
    (function () {
      window.dispatchEvent(new MessageEvent('message', {
        data: ${JSON.stringify(response)}
      }));
    })();
    true;
  `;
}

/** Parses a raw string coming from WebView's onMessage into a bridge request, or null if not ours. */
export function parseBridgeRequest(raw: string): BridgeRequest | null {
  try {
    const msg = JSON.parse(raw);
    if (
      msg &&
      msg.channel === NFC_BRIDGE_CHANNEL &&
      typeof msg.id === "string"
    ) {
      return msg as BridgeRequest;
    }
    return null;
  } catch {
    return null;
  }
}

/** Decodes a native NFC tag (from NfcManager.getTag()) into the wire shape the mini app expects. */
export function decodeTagToWire(tag: TagEvent): ReadResultWire {
  const nfc = lazyNfc();
  if (!nfc) {
    // Should not happen in native builds if this function is called, but for safety
    return { messages: [], tagInfo: { uid: tag.id } };
  }
  const { Ndef } = nfc;

  const ndefMessage = tag.ndefMessage ?? [];

  const records: NdefRecordWire[] = ndefMessage.map((record) => {
    const typeBytes = new Uint8Array(record.type as number[]);
    const payloadBytes = new Uint8Array(record.payload as number[]);
    const typeStr = Ndef.util.bytesToString(typeBytes);

    if (typeStr === "T") {
      return { type: "T", payload: Ndef.text.decodePayload(payloadBytes) };
    }
    if (typeStr === "U") {
      return { type: "U", payload: Ndef.uri.decodePayload(payloadBytes) };
    }
    return { type: typeStr || "unknown", payload: record.payload as number[] };
  });

  return {
    messages: [{ records }],
    tagInfo: { uid: tag.id },
  };
}

/** Encodes the mini app's write payload into NDEF bytes and writes it to the tag currently in range. */
export async function writeWirePayload(payload: WritePayload): Promise<void> {
  const nfc = lazyNfc();
  if (!nfc) {
    throw new Error("NFC_NOT_AVAILABLE");
  }
  const { NfcManager, Ndef } = nfc;

  const ndefRecords = payload.records.map((r) => {
    if (r.type === "U" && typeof r.payload === "string") {
      return Ndef.uriRecord(r.payload);
    }
    if (r.type === "T" && typeof r.payload === "string") {
      return Ndef.textRecord(r.payload);
    }
    throw new Error(`UNSUPPORTED_RECORD_TYPE:${r.type}`);
  });

  const bytes = Ndef.encodeMessage(ndefRecords);
  if (!bytes) {
    throw new Error("NDEF_ENCODE_FAILED");
  }
  await NfcManager.ndefHandler.writeNdefMessage(bytes);
}

export type { NfcAction, ReadResultWire, WritePayload };
