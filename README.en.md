# LiteGrid

[简体中文](README.md) | **English**

**A calm, native-feeling CSV and HTML editor for Obsidian.**

LiteGrid is for people who want structured data without visual overload. It keeps the editing power you need and tucks advanced options into menus that appear only when needed, so your data stays at home in Obsidian.

> The interface is currently in Simplified Chinese.

![Editing a CSV table with LiteGrid in Obsidian](screenshots/table-light.png)

## Features

- Open, edit, and save `.csv` files directly in Obsidian
- Typed fields for text, numbers, currency, single and multi select, dates, checkboxes, links, email, phone, images, and vault indexes
- Filtering, grouping, sorting, conditional fills, and adjustable rows and columns
- Obsidian internal-link indexes and local image previews
- Preview and visual editing for `.html` and `.htm` files with a source mode; previews run the page's own scripts in an isolated sandbox
- Local-first operation with no cloud dependency or telemetry

## Screenshots

### Grouping, sorting and the dark theme

![A table grouped by status and sorted by date, in the dark theme](screenshots/table-dark.png)

### HTML preview

HTML files open in preview by default, and the page's own scripts keep working. Switch to visual editing or source mode whenever you need to make changes.

![HTML preview mode](screenshots/html-preview.png)

## Design principles

- **Lightweight:** no separate database system to learn
- **Calm:** restrained color, spacing, and feedback
- **Native-feeling:** built around Obsidian theme variables and interaction patterns
- **File-first:** your data remains ordinary CSV and HTML files

## Installation

### Community plugins

Search for `LiteGrid` in **Settings → Community plugins → Browse** and install it.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. Create `.obsidian/plugins/litegrid/` in your vault.
3. Put the three files in that folder.
4. Reload Obsidian and enable **LiteGrid** in **Settings → Community plugins**.

## Development

```bash
npm install
npm run lint
npm run build
```

The release files are `main.js`, `manifest.json`, and `styles.css` in the repository root.

## Privacy

LiteGrid works offline. It does not collect analytics or transmit filenames or vault content. Image and index features access only local files inside the current Obsidian vault.

HTML previews run the page's own scripts inside an isolated sandbox: they cannot call Obsidian or read local files through network requests. Open untrusted HTML in source mode first.

## License

[0BSD](LICENSE)
