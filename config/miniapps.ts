export interface MiniApp {
  id: string;
  name: string;
  url: string;
}

export const MINIAPPS: MiniApp[] = [
  {
    id: "app1",
    name: "Example",
    url: "https://example.com",
  },
  {
    id: "app2",
    name: "NFC",
    url: "http://192.168.110.43:5173",
  },
];
