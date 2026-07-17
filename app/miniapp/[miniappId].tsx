import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { MINIAPPS } from "@/config/miniapps";
import {
  BridgeRequest,
  buildResponseInjection,
  consoleLogShim,
  decodeTagToWire,
  networkLogShim,
  NFC_BRIDGE_CHANNEL,
  parseBridgeRequest,
  postMessageShim,
  writeWirePayload,
} from "@/lib/nfc-bridge";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
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

  const [logMode, setLogMode] = useState<'none' | 'console' | 'network'>('none');
  const [showDropdown, setShowDropdown] = useState(false);
  const [consoleLogs, setConsoleLogs] = useState<string[]>([]);
  const [networkLogs, setNetworkLogs] = useState<NetworkEntry[]>([]);
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
    // Di sini Anda bisa menambahkan logika untuk menangani URL redirect
    // Misalnya, jika navState.url adalah URL callback setelah login, Anda bisa menutup WebView
    // Contoh:
    // if (navState.url.startsWith("your-app-scheme://auth/callback")) {
    //   router.back();
    // }
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
      <Stack.Screen options={{ title: app.name, headerTitleAlign: 'center', headerTitleStyle: { color: "#000" } }} />
      <SafeAreaView edges={["top"]} style={styles.safeArea}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.backButton}>
            <ThemedText style={styles.back}>Back</ThemedText>
          </Pressable>
          <ThemedText style={{ color: "#000", fontWeight: '600', flex: 1, textAlign: 'center' }}>{app.name}</ThemedText>
          <View>
            <Pressable onPress={() => setShowDropdown(true)} style={styles.backButton}>
              <ThemedText style={styles.back}>
                {logMode === 'none' ? 'Log' : logMode === 'console' ? 'Console' : 'Network'}
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
