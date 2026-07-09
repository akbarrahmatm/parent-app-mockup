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
        } catch (e) {
          // fall back silently, nothing else we can do from here
        }
      } else {
        originalPostMessage(message);
      }
    };
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
