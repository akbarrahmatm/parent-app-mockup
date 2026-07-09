# Parent App Mockup

This project is an Expo app designed to serve as a parent application capable of launching and interacting with mini-applications (Miniapps). It demonstrates core functionalities like:

- **Miniapp Integration**: Seamlessly launching and displaying mini-applications within the main app.
- **NFC Bridge**: Utilizing an NFC bridge to facilitate communication between the parent app and the Miniapps, enabling NFC-related functionalities (read, write, cancel, check support).
- **Custom Header Navigation**: Implementing custom headers for Miniapp screens with back navigation and dynamically displayed Miniapp titles.
- **Theming**: Basic theming support for text elements.

## Project Structure

- `app/`: Contains the main application screens and navigation.
  - `(tabs)/`: Tab-based navigation for the main sections.
    - `index.tsx`: The home screen displaying a list of available Miniapps.
  - `miniapp/[miniappId].tsx`: The screen responsible for rendering individual Miniapps within a WebView and handling NFC bridge communication.
- `components/`: Reusable UI components.
  - `themed-text.tsx`: A custom text component that supports theming.
- `config/`: Application configuration.
  - `miniapps.ts`: Defines the list of available Miniapps and their properties (ID, name, URL).
- `lib/`: Utility functions.
  - `nfc-bridge.ts`: Implements the NFC bridge logic for communication between the WebView and native NFC functionalities.
- `hooks/`: Custom React hooks.
  - `use-color-scheme.ts`: Hook for managing color scheme.
- `constants/`: Constant values.
  - `theme.ts`: Defines color schemes for light and dark modes.

## How to Run

1.  **Install dependencies**:
    ```bash
    npm install
    ```
2.  **Start the app**:
    ```bash
    npx expo start
    ```

    Follow the instructions in your terminal to open the app on a simulator, emulator, or physical device.

## Key Features Implemented

### Miniapp Navigation and Display

- The `app/(tabs)/index.tsx` lists available Miniapps using data from `config/miniapps.ts`.
- Tapping on a Miniapp card navigates to the `app/miniapp/[miniappId].tsx` screen.
- Each Miniapp is rendered within a `WebView` component, allowing web-based applications to run inside the native app.

### NFC Bridge Communication

- The `lib/nfc-bridge.ts` file defines the communication protocol between the WebView-rendered Miniapp and the native NFC module.
- `WebViewMessageEvent` is used to intercept messages from the Miniapp.
- The parent app handles NFC actions (`isSupported`, `read`, `write`, `cancel`) and responds to the Miniapp through JavaScript injection into the WebView.
- Integration with `react-native-nfc-manager` is conditionally loaded to support NFC functionalities.

### Custom Header for Miniapps

- The `miniapp/[miniappId].tsx` screen features a custom header:
    - A "Back" button to navigate to the previous screen.
    - A centered title displaying the Miniapp's name.
    - The title and back button text are styled for better visibility.

## Customizations Made

- **Miniapp Back Button**: Changed text from "Kembali" to "Back" and adjusted color for better contrast.
- **Miniapp Title Styling**: Ensured the Miniapp title is dark-colored and horizontally centered within the custom header.
- **Index Page Miniapp Names**: Explicitly set `item.name` text color to black in `app/(tabs)/index.tsx` for consistency.