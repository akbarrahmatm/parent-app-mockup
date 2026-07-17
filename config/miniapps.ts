export interface MiniApp {
  id: string;
  name: string;
  url: string;
}

export const MINIAPPS: MiniApp[] = [
  {
    id: "app1",
    name: "@akbarrahmatm",
    url: "https://akbarrahmatm.my.id",
  },
  {
    id: "app2",
    name: "Example",
    url: "https://example.com",
  },
  {
    id: "app3",
    name: "NFC Integration",
    url: "http://192.168.110.43:5173",
  },
];
