import { FlatList, StyleSheet, Pressable } from 'react-native';
import { Link } from 'expo-router';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MINIAPPS } from '@/config/miniapps';

export default function HomeScreen() {
  return (
    <ThemedView style={styles.container}>
      <ThemedText type="title" style={styles.title}>MiniApps</ThemedText>
      <FlatList
        data={MINIAPPS}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Link href={`/miniapp/${item.id}`} asChild>
            <Pressable style={styles.appCard}>
              <ThemedText type="defaultSemiBold" style={{ color: '#000' }}>{item.name}</ThemedText>
              <ThemedText style={styles.url}>{item.url}</ThemedText>
            </Pressable>
          </Link>
        )}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, paddingTop: 60 },
  title: { marginBottom: 20 },
  appCard: { padding: 16, backgroundColor: '#f0f0f0', borderRadius: 8, marginBottom: 12 },
  url: { fontSize: 12, color: '#666' }
});
