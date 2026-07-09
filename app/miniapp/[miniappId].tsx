import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { MINIAPPS } from "@/config/miniapps";
import {
  BridgeRequest,
  buildResponseInjection,
  decodeTagToWire,
  NFC_BRIDGE_CHANNEL,
  parseBridgeRequest,
  postMessageShim,
  writeWirePayload,
} from "@/lib/nfc-bridge";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView, WebViewMessageEvent } from "react-native-webview";

const disableZoomScript = `
  const meta = document.createElement('meta');
  meta.name = 'viewport';
  meta.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no';
  document.getElementsByTagName('head')[0].appendChild(meta);
  true;
`;

// Runs before the page's own JS, so nfc.ts's very first window.parent.postMessage
// call is already routed to native by the time it fires.
const injectedBeforeLoad = postMessageShim;

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
      console.log("WebView message:", event.nativeEvent.data);
      const req: BridgeRequest | null = parseBridgeRequest(
        event.nativeEvent.data,
      );
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
          <View style={styles.backButton} />
        </View>
      </SafeAreaView>
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
  backButton: { width: 60 },
  back: { color: "#333", fontSize: 16 },
  webview: { flex: 1 },
});
