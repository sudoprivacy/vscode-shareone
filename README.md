# ShareOne for VS Code

Publish local files to ShareOne links and collect review comments without leaving VS Code.

## Features

- Publish the active file to ShareOne.
- Publish with title, password, watermark, custom slug, and comments enabled.
- Save a workspace mapping from local file path to ShareOne `share_id` in `.shareone/shares.json`.
- Update an existing HTML, Markdown, or TXT share in place.
- Change share settings for an already tracked file.
- View published ShareOne links in the ShareOne activity bar.
- Click a link to open the mapped file and the ShareOne Review panel beside the editor.
- Open the ShareOne web management page from the Links view.
- Review comments with usernames, timestamps, replies, and source locations.
- Click a comment card or its locate button to jump to the source text.
- Use editor CodeLens or the review panel to reply to or resolve comments.

## Setup

1. Right-click a file and run `ShareOne: Publish / Update...`.
2. If VS Code has not been authorized yet, choose browser authorization.
3. Sign in or create a ShareOne account in the browser. ShareOne redirects back to VS Code automatically and the extension continues publishing.

`Publish With Options` opens a single configuration form for title, password, watermark, custom slug, and comments.
When the file is already tracked, `Publish / Update...` offers update, settings, open link, and copy link actions instead of pushing you toward a duplicate publish.

## File Bindings

ShareOne bindings are stored in the current workspace:

```txt
.shareone/shares.json
```

The binding uses the file's workspace-relative path, so it survives VS Code restarts and works across machines when the project path is the same inside the workspace. File content changes do not affect the binding.

If you rename or move a file inside VS Code, the extension updates the binding automatically. If you rename it outside VS Code, publish the renamed file again so the workspace can store the new local binding.

The API key returned by the browser authorization flow is stored with VS Code `SecretStorage`. `ShareOne: Set API Key` remains available for manual development or account migration.
When an action needs owner permission, such as publishing, updating settings, replying, or resolving comments, the extension starts browser authorization automatically if VS Code has no saved authorization.

## Comment Workflow

1. Publish an HTML, Markdown, or TXT file with comments enabled.
2. Share the generated link.
3. Open the ShareOne activity bar and click the published link.
4. The ShareOne Review panel opens on the right and refreshes comments once for only that link. Use `Refresh` in that panel to manually reload the same link later.
5. Click a comment card or its locate button in the Review panel to scroll to its source text and highlight the quote.
6. Edit the file manually.
7. Run `ShareOne: Update Existing Share`.
8. Use CodeLens or the Review panel to reply to or resolve comments.

The ShareOne Links view only shows links published or updated from this workspace.

The extension does not auto-poll comments and does not refresh all tracked links at once. Opening the ShareOne Links view only reads local bindings; fetching comments happens when a link opens in the Review panel and when you click `Refresh` in that panel for the active link.

When the quote is not found locally, the extension keeps focus in ShareOne Review and shows a warning. It does not switch VS Code to global Search.

Decorations are clickable only through VS Code's native CodeLens actions; VS Code does not expose direct click handlers for highlighted text decorations. The current implementation keeps the source file in the normal editor tab and the comment list in a reusable side Review tab. A true single-tab split source/comment editor would need a custom webview editor and would not behave like a native editable VS Code text file.

### Markdown comment location

ShareOne comments are anchored to the rendered HTML shown in the browser. For Markdown shares, the browser quote may differ from the `.md` source because Markdown markers are removed during rendering.

The extension maps Markdown source to approximate rendered text before locating comments. It also uses ShareOne's text anchor metadata (`parentTagName`, `parentIndex`, and `textOffset`) to prefer the matching rendered block before falling back to global quote matching. It handles common syntax such as headings, lists, task lists, blockquotes, emphasis, inline code, links, HTML tags, entities, frontmatter, and fenced code blocks.

Some cases are still best-effort: duplicate quoted text, complex raw HTML, tables with unusual formatting, Mermaid diagrams rendered as SVG, and comments created with element-point anchors may not map precisely to the Markdown source.

This extension intentionally does not auto-modify source files. AI-assisted comment processing belongs in Codex, Claude Code, DSH, or another agent environment.

## Development

```bash
npm install
npm run compile
```

Open this directory in VS Code, press F5, and run the extension in the Extension Development Host.
