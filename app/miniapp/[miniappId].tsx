import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { MINIAPPS } from "@/config/miniapps";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

const disableZoomScript = `
  const meta = document.createElement('meta');
  meta.name = 'viewport';
  meta.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no';
  document.getElementsByTagName('head')[0].appendChild(meta);
  true;
`;

export default function MiniAppScreen() {
  const { miniappId } = useLocalSearchParams<{ miniappId: string }>();
  const app = MINIAPPS.find((m) => m.id === miniappId);

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
      <Stack.Screen options={{ title: app.name }} />
      <SafeAreaView edges={["top"]} style={styles.safeArea}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()}>
            <ThemedText style={styles.back}>Kembali</ThemedText>
          </Pressable>
          <ThemedText type="defaultSemiBold">{app.name}</ThemedText>
          <View style={{ width: 60 }} />
        </View>
      </SafeAreaView>
      <WebView
        source={{ uri: app.url }}
        style={styles.webview}
        injectedJavaScript={disableZoomScript}
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
  back: { color: "#007AFF", fontSize: 16 },
  webview: { flex: 1 },
});
