# UI Primitives Manifest

## Purpose
Single-source-of-truth UI component library implementing DataStack's compact, zero-border-radius, zero-shadow design system.

## Components
- `Button.tsx`: Action buttons with variants (`primary`, `secondary`, `ghost`, `danger`, `icon`) and sizes (`default`, `sm`, `xs`, `icon`).
- `Input.tsx`: Standardized `Input`, `Textarea`, and `Select` controls with compact mode and right-element slots.
- `Card.tsx`: Structured 1px-bordered surface containers (`Card`, `CardHeader`, `CardTitle`, `CardContent`, `CardFooter`).
- `Panel.tsx`: Titled section container with optional metadata badge and header action slot.
- `StatStrip.tsx`: Responsive 4-column metric strip used at the top of `/vcon/*` views.
- `Table.tsx`: Compact tabular data primitives (`TableWrap`, `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell`, `TableEmpty`).
- `Modal.tsx`: Accessible modal dialog with Escape key handling and action footer.
- `Form.tsx`: Form layout wrappers and `FormSwitch` boolean toggle control.
- `Pill.tsx`: Compact filter pill button for status and date-range selection.
- `CodeBlock.tsx`: Monospace syntax block for displaying SDK snippets and JSON payloads.
- `CopyButton.tsx`: Clipboard copy button with visual confirmation state.
- `Text.tsx`: Typography helper component for headings, labels, and inline code.
- `Icon.tsx`: Dynamic Lucide icon renderer.
- `Toast.tsx`: Toast notification provider (`useToast`) for operation feedback.
