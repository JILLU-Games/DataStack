# Layout Components Manifest

## Purpose
Global layout shells, navigation headers, and sidebars shared across the public overview and `/vcon/*` administration console.

## Components
- `MainLayout.tsx`: Responsive root shell pairing the top navigation bar, sidebar (for `/vcon/*` routes), and scrollable main content region.
- `Navbar.tsx`: Top navigation bar displaying the brand, quick links, dark/light theme toggle, and authenticated administrator controls.
- `Sidebar.tsx`: Collapsible `/vcon/*` administration navigation rail with mobile drawer support.
- `PageShell.tsx`: Standard page container used by all `/vcon/*` views, pairing `AdminPageHeader` with consistent vertical spacing.
- `AdminPageHeader.tsx`: Compact page header rendering the current route title and right-aligned action buttons.
- `SettingsPanel.tsx`: Two-column key/value configuration layout used by `/vcon/settings` and `/vcon/profile`.
- `Footer.tsx`: Compact status footer for public landing pages.
