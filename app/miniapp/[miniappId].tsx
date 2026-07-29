import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { MINIAPPS } from "@/config/miniapps";
import {
  BridgeRequest,
  buildResponseInjection,
  clearIndexedDBScript,
  clearNetworkCacheScript,
  consoleLogShim,
  decodeTagToWire,
  indexedDBDumpScript,
  networkLogShim,
  NFC_BRIDGE_CHANNEL,
  parseBridgeRequest,
  postMessageShim,
  writeWirePayload,
} from "@/lib/nfc-bridge";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { BackHandler, FlatList, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView, WebViewMessageEvent } from "react-native-webview";

type NetworkEntry = {
  method: string;
  url: string;
  status: number;
  statusText: string;
  duration: number;
  body: string;
};

type IndexedDBEntry = {
  name: string;
  version: number;
  stores: { name: string; records: any[] }[];
};

const disableZoomScript = `
  const meta = document.createElement('meta');
  meta.name = 'viewport';
  meta.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no';
  document.getElementsByTagName('head')[0].appendChild(meta);
  true;
`;

// Runs before the page's own JS, so nfc.ts's very first window.parent.postMessage
// call is already routed to native by the time it fires.
const injectedBeforeLoad = postMessageShim + consoleLogShim + networkLogShim;

function lazyNfc() {
  try {
    const mod = require("react-native-nfc-manager");
    return {
      NfcManager: mod.default ?? mod,
      NfcTech: mod.NfcTech,
    };
  } catch {
    return null;
  }
}

export default function MiniAppScreen() {
  const { miniappId } = useLocalSearchParams<{ miniappId: string }>();
  const app = MINIAPPS.find((m) => m.id === miniappId);
  const webviewRef = useRef<WebView>(null);

  // Tracks the id of the request currently holding the NFC session, so a
  // 'cancel' from the mini app only tears down its own in-flight request.
  const activeRequestId = useRef<string | null>(null);

  const [logMode, setLogMode] = useState<'none' | 'console' | 'network' | 'indexeddb'>('none');
  const [showDropdown, setShowDropdown] = useState(false);
  const [consoleLogs, setConsoleLogs] = useState<string[]>([]);
  const [networkLogs, setNetworkLogs] = useState<NetworkEntry[]>([]);
  const [offlineMode, setOfflineMode] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [indexedDBData, setIndexedDBData] = useState<IndexedDBEntry[]>([]);
  const logsRef = useRef<FlatList<string>>(null);
  const networkRef = useRef<FlatList<NetworkEntry>>(null);

  useEffect(() => {
    const nfc = lazyNfc();
    if (!nfc) return;
    nfc.NfcManager.start();
    return () => {
      nfc.NfcManager.cancelTechnologyRequest().catch(() => {});
    };
  }, []);

  const respond = useCallback(
    (id: string, ok: boolean, data?: unknown, error?: string) => {
      const js = buildResponseInjection({
        channel: NFC_BRIDGE_CHANNEL,
        id,
        ok,
        data,
        error,
      });
      webviewRef.current?.injectJavaScript(js);
    },
    [],
  );

  const handleIsSupported = useCallback(
    async (id: string) => {
      const nfc = lazyNfc();
      if (!nfc) {
        respond(id, true, { supported: false });
        return;
      }
      try {
        const supported = await nfc.NfcManager.isSupported();
        respond(id, true, { supported });
      } catch {
        respond(id, true, { supported: false });
      }
    },
    [respond],
  );

  const handleRead = useCallback(
    async (id: string) => {
      const nfc = lazyNfc();
      if (!nfc) {
        respond(id, false, undefined, "NFC_NOT_AVAILABLE");
        return;
      }
      activeRequestId.current = id;
      try {
        if (Platform.OS === "android") {
          const enabled = await nfc.NfcManager.isEnabled();
          if (!enabled) {
            respond(id, false, undefined, "NFC_DISABLED");
            return;
          }
        }

        await nfc.NfcManager.requestTechnology(nfc.NfcTech.Ndef);
        const tag = await nfc.NfcManager.getTag();
        if (!tag) {
          respond(id, false, undefined, "NO_TAG_FOUND");
          return;
        }
        respond(id, true, decodeTagToWire(tag));
      } catch (err) {
        respond(
          id,
          false,
          undefined,
          err instanceof Error ? err.message : String(err),
        );
      } finally {
        nfc.NfcManager.cancelTechnologyRequest().catch(() => {});
        if (activeRequestId.current === id) activeRequestId.current = null;
      }
    },
    [respond],
  );

  const handleWrite = useCallback(
    async (id: string, payload: unknown) => {
      const nfc = lazyNfc();
      if (!nfc) {
        respond(id, false, undefined, "NFC_NOT_AVAILABLE");
        return;
      }
      activeRequestId.current = id;
      try {
        if (Platform.OS === "android") {
          const enabled = await nfc.NfcManager.isEnabled();
          if (!enabled) {
            respond(id, false, undefined, "NFC_DISABLED");
            return;
          }
        }

        await nfc.NfcManager.requestTechnology(nfc.NfcTech.Ndef);
        await writeWirePayload(
          payload as {
            records: { type: string; payload: string | number[] }[];
          },
        );
        respond(id, true);
      } catch (err) {
        respond(
          id,
          false,
          undefined,
          err instanceof Error ? err.message : String(err),
        );
      } finally {
        nfc.NfcManager.cancelTechnologyRequest().catch(() => {});
        if (activeRequestId.current === id) activeRequestId.current = null;
      }
    },
    [respond],
  );

  const handleCancel = useCallback((id: string) => {
    if (activeRequestId.current !== id) return;
    const nfc = lazyNfc();
    if (nfc) nfc.NfcManager.cancelTechnologyRequest().catch(() => {});
    activeRequestId.current = null;
  }, []);

  const handleBack = useCallback(() => {
    if (canGoBack) {
      webviewRef.current?.goBack();
    } else {
      router.back();
    }
  }, [canGoBack]);

  useEffect(() => {
    webviewRef.current?.injectJavaScript(`window.__networkBlocked = ${offlineMode}; true;`);
  }, [offlineMode]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const onBackPress = () => {
      if (canGoBack) {
        webviewRef.current?.goBack();
        return true;
      }
      return false;
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBackPress);
    return () => sub.remove();
  }, [canGoBack]);

  useEffect(() => {
    if (logMode !== 'indexeddb') return;
    setIndexedDBData([]);
    webviewRef.current?.injectJavaScript(indexedDBDumpScript);
  }, [logMode]);

  const handleClearIndexedDB = useCallback(() => {
    webviewRef.current?.injectJavaScript(clearIndexedDBScript);
    // re-dump after short delay so deleteDatabase settles
    setTimeout(() => {
      webviewRef.current?.injectJavaScript(indexedDBDumpScript);
    }, 300);
  }, []);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const raw = event.nativeEvent.data;
      console.log("WebView message:", raw);

      try {
        const parsed = JSON.parse(raw);
        if (parsed.channel === "__console__") {
          setConsoleLogs((prev) => [...prev, `[${parsed.level}] ${parsed.args.join(" ")}`]);
          return;
        }
        if (parsed.channel === "__network__") {
          const entry: NetworkEntry = {
            method: parsed.method,
            url: parsed.url,
            status: parsed.status,
            statusText: parsed.statusText,
            duration: parsed.duration,
            body: parsed.body,
          };
          setNetworkLogs((prev) => [...prev, entry]);
          return;
        }
        if (parsed.channel === "__indexeddb__") {
          setIndexedDBData(parsed.error ? [{ name: `Error: ${parsed.error}`, version: 0, stores: [] }] : parsed.data);
          return;
        }
      } catch {}

      const req: BridgeRequest | null = parseBridgeRequest(raw);
      if (!req) return;

      switch (req.action) {
        case "isSupported":
          handleIsSupported(req.id);
          break;
        case "read":
          handleRead(req.id);
          break;
        case "write":
          handleWrite(req.id, req.payload);
          break;
        case "cancel":
          handleCancel(req.id);
          break;
      }
    },
    [handleIsSupported, handleRead, handleWrite, handleCancel],
  );

  const onNavigationStateChange = useCallback((navState: any) => {
    console.log("WebView navigation:", navState.url);
    setCanGoBack(navState.canGoBack);
  }, []);

  if (!app) {
    return (
      <ThemedView style={styles.center}>
        <ThemedText type="title">Not found Miniapp</ThemedText>
        <Pressable onPress={() => router.back()}>
          <ThemedText style={styles.back}>Back</ThemedText>
        </Pressable>
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: `${app.name}${offlineMode ? ' (Offline)' : ''}`, headerTitleAlign: 'center', headerTitleStyle: { color: "#000" } }} />
      <SafeAreaView edges={["top"]} style={styles.safeArea}>
        <View style={styles.header}>
          <Pressable onPress={handleBack} style={styles.backButton}>
            <ThemedText style={styles.back}>{canGoBack ? '<' : 'Back'}</ThemedText>
          </Pressable>
          <ThemedText style={{ color: "#000", fontWeight: '600', flex: 1, textAlign: 'center' }}>{app.name}</ThemedText>
          <View>
            <Pressable onPress={() => setShowDropdown(true)} style={styles.backButton}>
              <ThemedText style={styles.back}>
                {offlineMode ? 'Offline' : logMode === 'none' ? 'Log' : logMode === 'console' ? 'Console' : logMode === 'network' ? 'Network' : 'IndexedDB'}
              </ThemedText>
            </Pressable>
            <Modal transparent visible={showDropdown} onRequestClose={() => setShowDropdown(false)}>
              <Pressable style={styles.dropdownOverlay} onPress={() => setShowDropdown(false)}>
                <View style={styles.dropdown}>
                  <Pressable onPress={() => { setLogMode('none'); setShowDropdown(false); }}>
                    <Text style={[styles.dropdownItem, logMode === 'none' && styles.dropdownActive]}>Hide</Text>
                  </Pressable>
                  <Pressable onPress={() => { setLogMode('console'); setShowDropdown(false); }}>
                    <Text style={[styles.dropdownItem, logMode === 'console' && styles.dropdownActive]}>Console</Text>
                  </Pressable>
                  <Pressable onPress={() => { setLogMode('network'); setShowDropdown(false); }}>
                    <Text style={[styles.dropdownItem, logMode === 'network' && styles.dropdownActive]}>Network</Text>
                  </Pressable>
                  <Pressable onPress={() => { setLogMode('indexeddb'); setShowDropdown(false); }}>
                    <Text style={[styles.dropdownItem, logMode === 'indexeddb' && styles.dropdownActive]}>IndexedDB</Text>
                  </Pressable>
                  <View style={{ height: 1, backgroundColor: '#e0e0e0', marginVertical: 4 }} />
                  <Pressable onPress={() => { setOfflineMode(v => !v); setShowDropdown(false); }}>
                    <Text style={[styles.dropdownItem, offlineMode && styles.dropdownActive]}>{offlineMode ? '✓ Offline' : '   Offline'}</Text>
                  </Pressable>
                </View>
              </Pressable>
            </Modal>
          </View>
        </View>
      </SafeAreaView>
      <View style={{ flex: 1 }}>
        <WebView
          ref={webviewRef}
          source={{ uri: app.url }}
          style={styles.webview}
          injectedJavaScriptBeforeContentLoaded={injectedBeforeLoad}
          injectedJavaScript={disableZoomScript}
          onMessage={onMessage}
          onNavigationStateChange={onNavigationStateChange}
          // ponytail: restrict to known origins in prod
          originWhitelist={["*"]}
        />
        {logMode === 'console' && (
          <View style={styles.logOverlay}>
            <FlatList
              ref={logsRef}
              data={consoleLogs}
              keyExtractor={(_, i) => String(i)}
              renderItem={({ item }) => (
                <Text style={styles.logText} numberOfLines={5}>{item}</Text>
              )}
              onContentSizeChange={() => logsRef.current?.scrollToEnd()}
            />
          </View>
        )}
        {logMode === 'network' && (
          <View style={styles.logOverlay}>
            <FlatList
              ref={networkRef}
              data={networkLogs}
              keyExtractor={(_, i) => String(i)}
              renderItem={({ item }) => (
                <View style={{ marginBottom: 4 }}>
                  <Text style={styles.logText}>
                    <Text style={{ color: item.status >= 200 && item.status < 300 ? '#4caf50' : '#f44336' }}>
                      {item.method}
                    </Text>
                    {' '}
                    <Text style={{ color: '#fff' }}>{item.status}</Text>
                    {' '}
                    <Text style={{ color: '#aaa' }}>{item.duration}ms</Text>
                  </Text>
                  <Text style={[styles.logText, { color: '#9e9e9e' }]} numberOfLines={2}>{item.url}</Text>
                  {item.body ? <Text style={[styles.logText, { color: '#888' }]} numberOfLines={3}>{item.body}</Text> : null}
                </View>
              )}
              onContentSizeChange={() => networkRef.current?.scrollToEnd()}
            />
          </View>
        )}
        {logMode === 'indexeddb' && (
          <Modal visible animationType="slide" onRequestClose={() => setLogMode('none')}>
            <SafeAreaView style={{ flex: 1, backgroundColor: '#1a1a2e' }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#333' }}>
                <Pressable onPress={() => setLogMode('none')}>
                  <Text style={{ color: '#4fc3f7', fontSize: 16 }}>Close</Text>
                </Pressable>
                <View style={{ flexDirection: 'row', gap: 16 }}>
                  <Pressable onPress={() => webviewRef.current?.injectJavaScript(indexedDBDumpScript)}>
                    <Text style={{ color: '#4caf50', fontSize: 16 }}>Refresh</Text>
                  </Pressable>
                  <Pressable onPress={() => webviewRef.current?.injectJavaScript(clearNetworkCacheScript)}>
                    <Text style={{ color: '#ff9800', fontSize: 16 }}>Cache</Text>
                  </Pressable>
                  <Pressable onPress={handleClearIndexedDB}>
                    <Text style={{ color: '#f44336', fontSize: 16 }}>Clear</Text>
                  </Pressable>
                </View>
              </View>
              <FlatList
                data={indexedDBData}
                keyExtractor={(_, i) => String(i)}
                contentContainerStyle={{ padding: 12 }}
                renderItem={({ item }) => (
                  <View style={{ marginBottom: 16 }}>
                    <Text style={{ color: '#4fc3f7', fontSize: 13, fontWeight: '700', marginBottom: 4 }}>{item.name}</Text>
                    {item.stores.map((store, si) => [
                      <Text key={`h-${si}`} style={{ color: '#81c784', fontSize: 12, fontWeight: '600', marginBottom: 4, marginTop: 2 }}>▸ {store.name}</Text>,
                      ...store.records.map((rec, ri) => (
                        <View key={`${si}-${ri}`} style={{ backgroundColor: '#16213e', borderRadius: 6, padding: 10, marginBottom: 6 }}>
                          <Text style={{ color: '#e0e0e0', fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', lineHeight: 18 }}>
                            {JSON.stringify(rec, null, 2)}
                          </Text>
                        </View>
                      ))
                    ])}
                    {item.stores.length === 0 && !item.name.startsWith('Error') && (
                      <Text style={{ color: '#666', fontSize: 12 }}>(empty)</Text>
                    )}
                  </View>
                )}
              />
            </SafeAreaView>
          </Modal>
        )}
      </View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  safeArea: { backgroundColor: "#fff" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#e0e0e0",
  },
  backButton: { width: 70, alignItems: "center" },
  back: { color: "#333", fontSize: 14 },
  dropdownOverlay: {
    flex: 1,
    justifyContent: "flex-start",
    alignItems: "flex-end",
    paddingTop: 100,
    paddingRight: 10,
  },
  dropdown: {
    backgroundColor: "#fff",
    borderRadius: 8,
    paddingVertical: 4,
    elevation: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    minWidth: 120,
  },
  dropdownItem: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    fontSize: 14,
    color: "#333",
  },
  dropdownActive: {
    fontWeight: "700",
    color: "#007aff",
  },
  webview: { flex: 1 },
  logOverlay: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 200,
    backgroundColor: "rgba(0,0,0,0.85)",
    padding: 8,
  },
  logText: {
    color: "#0f0",
    fontSize: 11,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
});
