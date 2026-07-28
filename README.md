<h1 align="center">Yumi</h1>

<p align="center">
  An open-source (MIT) ebook reader with an Apple Books-inspired reading experience.
</p>

<p align="center">
  <a href="https://github.com/Igidn/yumi/releases">Download</a>
  ·
  <a href="https://github.com/Igidn/yumi">Source</a>
</p>

---

## Video

<!-- Add a demo video (YouTube embed, GIF, or MP4 link) -->

## Screenshots

<!-- Add screenshots: library, reader, search, drawing panel -->

---

## Development

```bash
# Clone and install
git clone https://github.com/Igidn/yumi.git
cd yumi
npm install

# Start in dev mode (main process + Vite renderer)
npm run dev

# Package for distribution
npm run package
```

### Scripts

| Command               | Description                                       |
| --------------------- | ------------------------------------------------- |
| `npm run dev`         | Start main + renderer in watch mode               |
| `npm run build`       | Build both processes for production               |
| `npm run package`     | Build + create distributable via electron-builder |
| `npm run db:generate` | Generate Drizzle schema migrations                |
| `npm run db:migrate`  | Run SQLite migrations                             |
| `npm run lint`        | ESLint                                            |
| `npm run format`      | Prettier                                          |

### Tech stack

| Layer        |                                    |
| ------------ | ---------------------------------- |
| Runtime      | Electron 33                        |
| UI           | React 19, Tailwind CSS 4           |
| State        | Zustand                            |
| Database     | better-sqlite3 + Drizzle ORM       |
| EPUB parsing | @xmldom/xmldom, JSZip              |
| Drawing      | @excalidraw/excalidraw             |
| Math         | KaTeX                              |
| Tooling      | TypeScript, Vite, ESLint, Prettier |

## License

MIT © [Igidn](https://github.com/Igidn)
