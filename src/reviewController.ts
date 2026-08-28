import * as path from "path";
import * as vscode from "vscode";
import { ShareOneApi } from "./api";
import { ShareOneComment, WorkspaceShare } from "./types";

type AnchoredComment = {
  share: WorkspaceShare;
  comment: ShareOneComment;
  anchorType: CommentAnchorType;
  range?: vscode.Range;
};

type ReviewMessage =
  | { command: "jump"; commentId: string }
  | { command: "reply"; commentId: string }
  | { command: "resolve"; commentId: string }
  | { command: "refresh" };

type AnchorLocationHints = {
  markdownTagIndexOffsets: Map<string, number>;
};

type CommentAnchorType = "text" | "region" | "unknown";

export class ReviewController implements vscode.CodeLensProvider {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
    border: "1px solid",
    borderColor: new vscode.ThemeColor("editor.findMatchBorder"),
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.findMatchForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Right
  });
  private readonly codeLensChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.codeLensChanged.event;

  private panel?: vscode.WebviewPanel;
  private activeShare?: WorkspaceShare;
  private activeComments: ShareOneComment[] = [];
  private commentsByShare = new Map<string, ShareOneComment[]>();
  private loadedShareIds = new Set<string>();
  private anchors = new Map<string, AnchoredComment[]>();
  private sourceColumn?: vscode.ViewColumn;

  constructor(
    private readonly api: ShareOneApi,
    private readonly refreshTree: (shareId?: string) => void,
    private readonly ensureApiKey: () => Promise<boolean>
  ) {}

  dispose(): void {
    this.decoration.dispose();
    this.codeLensChanged.dispose();
    this.panel?.dispose();
  }

  async openComment(node: { share: WorkspaceShare; comment: ShareOneComment }): Promise<void> {
    const comments = this.commentsByShare.get(node.share.shareId) ?? [];
    if (!comments.some((comment) => comment.id === node.comment.id)) {
      comments.push(node.comment);
      this.commentsByShare.set(node.share.shareId, comments);
    }
    await this.showReview(node.share, comments, node.comment.id);
  }

  async openReview(share: WorkspaceShare, selectedCommentId?: string): Promise<void> {
    await this.showReview(share, this.commentsByShare.get(share.shareId) ?? [], selectedCommentId);
    await this.refreshReview(share, selectedCommentId);
  }

  private async refreshReview(share: WorkspaceShare, selectedCommentId?: string): Promise<void> {
    if (!share.commentsEnabled) {
      await this.showReview(share, [], selectedCommentId);
      vscode.window.showInformationMessage("Comments are not enabled for this ShareOne link.");
      return;
    }

    this.activeShare = share;
    this.activeComments = await this.api.listComments(share.shareId, "unresolved");
    this.commentsByShare.set(share.shareId, this.activeComments);
    this.loadedShareIds.add(share.shareId);
    await this.showReview(share, this.activeComments, selectedCommentId);
    this.refreshTree(share.shareId);
  }

  private async showReview(share: WorkspaceShare, comments: ShareOneComment[], selectedCommentId?: string): Promise<void> {
    this.activeShare = share;
    this.activeComments = comments;

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(share.filePath));
    const editor = await this.showSourceDocument(document);
    const anchors = this.buildAnchors(document, share, comments);
    this.anchors.set(document.uri.toString(), anchors);
    this.applyDecorations(editor, anchors);
    this.codeLensChanged.fire();

    const selected = selectedCommentId ? anchors.find((anchor) => anchor.comment.id === selectedCommentId) : undefined;
    if (selected) {
      await this.revealAnchor(editor, selected);
    }

    this.showPanel(share, anchors, selectedCommentId);
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const anchors = this.anchors.get(document.uri.toString()) ?? [];
    const lenses: vscode.CodeLens[] = [];

    for (const anchor of anchors) {
      if (!anchor.range) continue;
      const lineRange = new vscode.Range(anchor.range.start.line, 0, anchor.range.start.line, 0);
      lenses.push(
        new vscode.CodeLens(lineRange, {
          title: `ShareOne: ${oneLine(anchor.comment.content, 60)}`,
          command: "shareone.openCommentReview",
          arguments: [{ kind: "comment", share: anchor.share, comment: anchor.comment }]
        }),
        new vscode.CodeLens(lineRange, {
          title: "Reply",
          command: "shareone.replyComment",
          arguments: [{ kind: "comment", share: anchor.share, comment: anchor.comment }]
        }),
        new vscode.CodeLens(lineRange, {
          title: "Resolve",
          command: "shareone.resolveComment",
          arguments: [{ kind: "comment", share: anchor.share, comment: anchor.comment }]
        })
      );
    }

    return lenses;
  }

  async jumpToComment(commentId: string): Promise<void> {
    const share = this.activeShare;
    if (!share) return;

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(share.filePath));
    const editor = await this.showSourceDocument(document);
    const anchors = this.anchors.get(document.uri.toString()) ?? this.buildAnchors(document, share, this.activeComments);
    this.anchors.set(document.uri.toString(), anchors);
    this.applyDecorations(editor, anchors);

    const anchor = anchors.find((item) => item.comment.id === commentId);
    if (!anchor) return;
    await this.revealAnchor(editor, anchor);
    this.showPanel(share, anchors, commentId);
  }

  async replyToComment(share: WorkspaceShare, comment: ShareOneComment): Promise<void> {
    if (!(await this.ensureApiKey())) return;

    const content = await vscode.window.showInputBox({
      title: "Reply to ShareOne comment",
      prompt: "Reply shown on the ShareOne page.",
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : "Reply is required")
    });
    if (!content) return;

    await this.api.replyToComment(share.shareId, comment.id, content.trim());
    this.refreshTree(share.shareId);
    await this.refreshReview(share, comment.id);
  }

  async resolveComment(share: WorkspaceShare, comment: ShareOneComment): Promise<void> {
    if (!(await this.ensureApiKey())) return;

    await this.api.updateCommentStatus(share.shareId, comment.id, "resolved");
    this.refreshTree(share.shareId);
    await this.refreshReview(share);
  }

  private buildAnchors(document: vscode.TextDocument, share: WorkspaceShare, comments: ShareOneComment[]): AnchoredComment[] {
    const hints = createAnchorLocationHints(document, share, comments);
    return comments.map((comment) => {
      const anchorType = commentAnchorType(comment.highlighter_data);
      return {
        share,
        comment,
        anchorType,
        range: anchorType === "region" ? undefined : findText(document, comment.quote?.trim(), share.filePath, comment.highlighter_data, hints)
      };
    });
  }

  private applyDecorations(editor: vscode.TextEditor, anchors: AnchoredComment[]): void {
    const options = anchors
      .filter((anchor): anchor is AnchoredComment & { range: vscode.Range } => Boolean(anchor.range))
      .map((anchor) => ({
        range: anchor.range,
        hoverMessage: new vscode.MarkdownString(`**ShareOne ${anchor.comment.status}**\n\n${anchor.comment.content}`)
      }));
    editor.setDecorations(this.decoration, options);
  }

  private async revealAnchor(editor: vscode.TextEditor, anchor: AnchoredComment): Promise<void> {
    if (!anchor.range) {
      if (anchor.anchorType === "region") {
        vscode.window.showInformationMessage("区域评论无法映射到源码文本。");
        return;
      }
      vscode.window.showWarningMessage("Quote was not found in the mapped local file.");
      return;
    }

    editor.selection = new vscode.Selection(anchor.range.start, anchor.range.end);
    editor.revealRange(anchor.range, vscode.TextEditorRevealType.InCenter);
  }

  private async showSourceDocument(document: vscode.TextDocument): Promise<vscode.TextEditor> {
    const visibleEditor = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === document.uri.toString());
    if (visibleEditor) {
      this.sourceColumn = visibleEditor.viewColumn;
      return vscode.window.showTextDocument(document, {
        viewColumn: visibleEditor.viewColumn,
        preserveFocus: false,
        preview: false
      });
    }

    const existingColumn = this.findOpenTextTabColumn(document.uri);
    const viewColumn = existingColumn ?? this.sourceColumn ?? vscode.ViewColumn.One;
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn,
      preserveFocus: false,
      preview: false
    });
    this.sourceColumn = editor.viewColumn;
    return editor;
  }

  private findOpenTextTabColumn(uri: vscode.Uri): vscode.ViewColumn | undefined {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputText && input.uri.toString() === uri.toString()) {
          return group.viewColumn;
        }
      }
    }
    return undefined;
  }

  private showPanel(share: WorkspaceShare, anchors: AnchoredComment[], selectedCommentId?: string): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "shareoneReview",
        "ShareOne Review",
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, retainContextWhenHidden: true }
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
      this.panel.webview.onDidReceiveMessage((message: ReviewMessage) => this.handleMessage(message));
    } else {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
    }

    const nonce = getNonce();
    const commentsLoaded = this.loadedShareIds.has(share.shareId) || anchors.length > 0;
    this.panel.webview.html = this.renderPanelHtml(nonce, share, anchors, selectedCommentId, commentsLoaded);
  }

  private async handleMessage(message: ReviewMessage): Promise<void> {
    const share = this.activeShare;
    if (!share) return;

    try {
      if (message.command === "jump") {
        await this.jumpToComment(message.commentId);
      } else if (message.command === "reply") {
        const comment = this.activeComments.find((item) => item.id === message.commentId);
        if (comment) await this.replyToComment(share, comment);
      } else if (message.command === "resolve") {
        const comment = this.activeComments.find((item) => item.id === message.commentId);
        if (comment) {
          await this.resolveComment(share, comment);
        }
      } else if (message.command === "refresh") {
        await this.refreshReview(share);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`ShareOne: ${text}`);
    }
  }

  private renderPanelHtml(
    nonce: string,
    share: WorkspaceShare,
    anchors: AnchoredComment[],
    selectedCommentId: string | undefined,
    commentsLoaded: boolean
  ): string {
    const cards = anchors
      .map((anchor) => {
        const selected = anchor.comment.id === selectedCommentId ? " selected" : "";
        const isRegionComment = anchor.anchorType === "region";
        const location = anchor.range
          ? `Line ${anchor.range.start.line + 1}`
          : isRegionComment
            ? "区域评论 · 无法映射到源码文本"
            : `${anchorKind(anchor.comment.highlighter_data)} not found locally`;
        const author = commentAuthorName(anchor.comment);
        const createdAt = formatCommentTime(anchor.comment.created_at);
        const edited = anchor.comment.edited_at ? `<span class="edited">edited</span>` : "";
        const anchorBadge = isRegionComment ? `<span class="anchor-badge">区域评论</span>` : "";
        const replies = anchor.comment.replies?.length
          ? `<div class="replies">${anchor.comment.replies
              .map((reply) => `<div class="reply">
                <div class="comment-meta">
                  <span class="author">${escapeHtml(commentAuthorName(reply))}</span>
                  <span>${escapeHtml(formatCommentTime(reply.created_at))}</span>
                  ${reply.edited_at ? `<span class="edited">edited</span>` : ""}
                </div>
                <div>${escapeHtml(reply.content)}</div>
              </div>`)
              .join("")}</div>`
          : "";
        return `<article class="comment${selected}" data-id="${escapeHtml(anchor.comment.id)}">
          <div class="comment-head">
            <div class="comment-meta">
              <span class="author">${escapeHtml(author)}</span>
                  <span>${escapeHtml(createdAt)}</span>
                  ${edited}
                  <span class="status">${escapeHtml(anchor.comment.status)}</span>
                  ${anchorBadge}
                </div>
            <button class="locate" data-action="jump" data-id="${escapeHtml(anchor.comment.id)}" title="${isRegionComment ? "Open file" : "Locate source"}" aria-label="${isRegionComment ? "Open file" : "Locate source"}">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="8" cy="8" r="5"></circle>
                <path d="M8 1v3M8 12v3M1 8h3M12 8h3"></path>
              </svg>
            </button>
          </div>
          <div class="location">${escapeHtml(location)}</div>
          <blockquote>${escapeHtml(anchor.comment.quote)}</blockquote>
          <p>${escapeHtml(anchor.comment.content)}</p>
          ${replies}
          <div class="actions">
            <button data-action="reply" data-id="${escapeHtml(anchor.comment.id)}">Reply</button>
            <button data-action="resolve" data-id="${escapeHtml(anchor.comment.id)}">Resolve</button>
          </div>
        </article>`;
      })
      .join("");
    const emptyText = !share.commentsEnabled
      ? "Comments are disabled for this link."
      : commentsLoaded
        ? "No unresolved comments."
        : "Click Refresh to load comments for this link.";

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ShareOne Review</title>
  <style>
    body {
      margin: 0;
      padding: 16px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }
    h1 {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
    }
    .meta {
      margin: 2px 0 0;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      word-break: break-all;
    }
    .comment {
      border: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
      border-radius: 6px;
      padding: 10px;
      margin: 0 0 10px;
      background: var(--vscode-sideBar-background);
      cursor: pointer;
    }
    .comment.selected {
      border-color: var(--vscode-focusBorder);
    }
    .comment:hover {
      border-color: var(--vscode-focusBorder);
    }
    .comment-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }
    .comment-meta {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      min-width: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .author {
      color: var(--vscode-foreground);
      font-weight: 600;
    }
    .status,
    .anchor-badge {
      padding: 1px 5px;
      border-radius: 999px;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
    }
    .anchor-badge {
      color: var(--vscode-inputOption-activeForeground);
      background: var(--vscode-inputOption-activeBackground);
    }
    .edited {
      font-style: italic;
    }
    .location {
      margin-top: 4px;
      color: var(--vscode-textLink-foreground);
      font-size: 12px;
    }
    .locate {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      min-width: 28px;
      height: 28px;
      padding: 0;
    }
    .locate svg {
      width: 15px;
      height: 15px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.6;
      stroke-linecap: round;
    }
    blockquote {
      margin: 8px 0;
      padding-left: 8px;
      color: var(--vscode-descriptionForeground);
      border-left: 2px solid var(--vscode-panel-border);
      white-space: pre-wrap;
    }
    p {
      margin: 8px 0;
      white-space: pre-wrap;
    }
    .replies {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .reply {
      margin-top: 6px;
      color: var(--vscode-descriptionForeground);
    }
    .actions {
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }
    button {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      border: 1px solid var(--vscode-button-border, transparent);
      min-height: 28px;
      padding: 3px 8px;
      font: inherit;
    }
    button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .empty {
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>${escapeHtml(share.filename)}</h1>
      <div class="meta">${escapeHtml(share.shareUrl)}</div>
    </div>
    <button id="refresh"${share.commentsEnabled ? "" : " disabled"}>Refresh</button>
  </header>
  ${cards || `<p class="empty">${escapeHtml(emptyText)}</p>`}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll(".comment").forEach((comment) => {
      comment.addEventListener("click", () => vscode.postMessage({ command: "jump", commentId: comment.dataset.id }));
    });
    document.querySelectorAll("[data-action='jump']").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        vscode.postMessage({ command: "jump", commentId: button.dataset.id });
      });
    });
    document.querySelectorAll("[data-action='reply']").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        vscode.postMessage({ command: "reply", commentId: button.dataset.id });
      });
    });
    document.querySelectorAll("[data-action='resolve']").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        vscode.postMessage({ command: "resolve", commentId: button.dataset.id });
      });
    });
    document.getElementById("refresh").addEventListener("click", () => vscode.postMessage({ command: "refresh" }));
  </script>
</body>
</html>`;
  }
}

export function findText(
  document: vscode.TextDocument,
  quote?: string,
  filePath?: string,
  highlighterData?: string,
  hints?: AnchorLocationHints
): vscode.Range | undefined {
  if (!quote) return undefined;
  if (commentAnchorType(highlighterData) === "region") return undefined;
  const anchor = parseTextAnchor(highlighterData);

  if (isMarkdownFile(filePath)) {
    const markdownRange = findMarkdownRenderedQuote(document, quote, anchor, hints);
    if (markdownRange) return markdownRange;
  }

  const htmlRange = findHtmlRenderedQuoteInAnchoredElement(document, quote, anchor?.startMeta);
  if (htmlRange) return htmlRange;

  const anchoredPlainRange = findPlainTextQuoteNearAnchor(document, quote, anchor?.startMeta);
  if (anchoredPlainRange) return anchoredPlainRange;

  const text = document.getText();
  const exactMatches = findRawMatches(text, quote);
  if (exactMatches.length === 1) {
    const index = exactMatches[0];
    return new vscode.Range(document.positionAt(index), document.positionAt(index + quote.length));
  }
  if (exactMatches.length > 1 && hasElementAnchor(anchor?.startMeta)) {
    return findNormalizedPlainText(document, quote, anchor?.startMeta, true);
  }
  if (exactMatches.length > 0) {
    const index = exactMatches[0];
    return new vscode.Range(document.positionAt(index), document.positionAt(index + quote.length));
  }

  return findNormalizedPlainText(document, quote, anchor?.startMeta);
}

function findPlainTextQuoteNearAnchor(
  document: vscode.TextDocument,
  quote: string,
  startMeta?: TextAnchorMeta
): vscode.Range | undefined {
  if (typeof startMeta?.textOffset !== "number") return undefined;
  if (startMeta.parentIndex !== undefined && startMeta.parentIndex !== -2) return undefined;

  const text = document.getText();
  const matches = findRawMatches(text, quote);
  if (matches.length === 0) return undefined;

  const index = nearestIndex(matches, startMeta.textOffset);
  return new vscode.Range(document.positionAt(index), document.positionAt(index + quote.length));
}

function createAnchorLocationHints(
  document: vscode.TextDocument,
  share: WorkspaceShare,
  comments: ShareOneComment[]
): AnchorLocationHints | undefined {
  if (!isMarkdownFile(share.filePath)) return undefined;

  const blocks = markdownRenderedAnchorElements(document.getText());
  const votes = new Map<string, Map<number, number>>();

  for (const comment of comments) {
    const quote = comment.quote?.trim();
    if (!quote) continue;

    const startMeta = parseTextAnchor(comment.highlighter_data)?.startMeta;
    if (!hasElementAnchor(startMeta) || !startMeta?.parentTagName) continue;

    const tagName = startMeta.parentTagName.toUpperCase();
    const matchingBlocks = findMarkdownBlocksContainingQuote(blocks, tagName, quote);
    if (matchingBlocks.length !== 1) continue;

    const offset = startMeta.parentIndex! - matchingBlocks[0].tagIndex;
    const tagVotes = votes.get(tagName) ?? new Map<number, number>();
    tagVotes.set(offset, (tagVotes.get(offset) ?? 0) + 1);
    votes.set(tagName, tagVotes);
  }

  const markdownTagIndexOffsets = new Map<string, number>();
  for (const [tagName, tagVotes] of votes) {
    const ranked = [...tagVotes.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked[0]) markdownTagIndexOffsets.set(tagName, ranked[0][0]);
  }

  return { markdownTagIndexOffsets };
}

function findMarkdownBlocksContainingQuote(blocks: MarkdownRenderedBlock[], tagName: string, quote: string): MarkdownRenderedBlock[] {
  const target = normalizeText(quote);
  if (!target) return [];
  return blocks.filter((block) => {
    if (block.tagName !== tagName) return false;
    const normalizedBlock = normalizeWithMap(block.text, (_, index) => block.map[index]);
    return normalizedBlock.text.includes(target);
  });
}

function findNormalizedPlainText(
  document: vscode.TextDocument,
  quote: string,
  startMeta?: TextAnchorMeta,
  avoidAmbiguousFirst = false
): vscode.Range | undefined {
  const mapped = normalizeWithMap(document.getText(), (_, index) => index);
  const target = normalizeText(quote);
  if (!target) return undefined;

  const matches = findRawMatches(mapped.text, target);
  if (matches.length === 0) return undefined;

  const normalizedPreferredOffset = sourceOffsetToNormalizedIndex(mapped.map, rootTextOffset(startMeta));
  if (matches.length > 1 && normalizedPreferredOffset === undefined && avoidAmbiguousFirst) {
    return undefined;
  }
  const index = nearestIndex(matches, normalizedPreferredOffset);
  const start = mapped.map[index];
  const end = mapped.map[index + target.length - 1] + 1;
  return new vscode.Range(document.positionAt(start), document.positionAt(end));
}

function findMarkdownRenderedQuote(
  document: vscode.TextDocument,
  quote: string,
  anchor?: { startMeta?: TextAnchorMeta; endMeta?: TextAnchorMeta },
  hints?: AnchorLocationHints
): vscode.Range | undefined {
  if (anchor?.startMeta?.parentTagName && typeof anchor.startMeta.parentIndex === "number") {
    const tagName = anchor.startMeta.parentTagName.toUpperCase();
    const blockRange = findMarkdownRenderedQuoteInAnchoredBlock(document, quote, anchor.startMeta, hints?.markdownTagIndexOffsets.get(tagName));
    if (blockRange) return blockRange;
  }

  const visible = markdownVisibleTextWithMap(document.getText());
  const normalizedVisible = normalizeWithMap(visible.text, (_, index) => visible.map[index]);
  const target = normalizeText(quote);
  if (!target) return undefined;

  const matches = findRawMatches(normalizedVisible.text, target);
  if (matches.length === 0) return undefined;

  const normalizedPreferredOffset = sourceOffsetToNormalizedIndex(normalizedVisible.map, rootTextOffset(anchor?.startMeta));
  if (matches.length > 1 && normalizedPreferredOffset === undefined && hasElementAnchor(anchor?.startMeta)) {
    return undefined;
  }
  const index = nearestIndex(matches, normalizedPreferredOffset);
  const start = normalizedVisible.map[index];
  const end = normalizedVisible.map[index + target.length - 1] + 1;
  return new vscode.Range(document.positionAt(start), document.positionAt(end));
}

function findMarkdownRenderedQuoteInAnchoredBlock(
  document: vscode.TextDocument,
  quote: string,
  startMeta: TextAnchorMeta,
  tagIndexOffset?: number
): vscode.Range | undefined {
  if (!startMeta.parentTagName || typeof startMeta.parentIndex !== "number" || startMeta.parentIndex < 0) return undefined;
  const tagName = startMeta.parentTagName.toUpperCase();
  const parentIndex = startMeta.parentIndex;
  const blocks = markdownRenderedAnchorElements(document.getText());
  const candidateTagIndexes = uniqueNumbers([
    typeof tagIndexOffset === "number" ? parentIndex - tagIndexOffset : undefined,
    parentIndex
  ]);

  for (const tagIndex of candidateTagIndexes) {
    const block = blocks.find((item) => item.tagName === tagName && item.tagIndex === tagIndex);
    if (!block) continue;
    const range = findQuoteInRenderedBlock(document, block, quote, startMeta.textOffset);
    if (range) return range;
  }

  const sameTagBlocks = blocks.filter((item) => item.tagName === tagName);
  const matchingBlocks = sameTagBlocks
    .map((block) => findQuoteInRenderedBlock(document, block, quote, startMeta.textOffset))
    .filter((range): range is vscode.Range => Boolean(range));
  if (matchingBlocks.length === 1) return matchingBlocks[0];

  return undefined;
}

function findQuoteInRenderedBlock(
  document: vscode.TextDocument,
  block: MarkdownRenderedBlock,
  quote: string,
  preferredTextOffset?: number
): vscode.Range | undefined {
  const normalizedBlock = normalizeWithMap(block.text, (_, index) => block.map[index]);
  const target = normalizeText(quote);
  if (!target) return undefined;

  const rawPreferredOffset = typeof preferredTextOffset === "number" ? preferredTextOffset : undefined;
  const matches: Array<{ normalizedIndex: number; distance: number }> = [];
  let index = normalizedBlock.text.indexOf(target);
  while (index !== -1) {
    const sourceOffset = normalizedBlock.map[index];
    const rawIndex = block.map.indexOf(sourceOffset);
    const distance = rawPreferredOffset === undefined || rawIndex === -1 ? 0 : Math.abs(rawIndex - rawPreferredOffset);
    matches.push({ normalizedIndex: index, distance });
    index = normalizedBlock.text.indexOf(target, index + 1);
  }

  if (matches.length === 0) return undefined;
  matches.sort((a, b) => a.distance - b.distance);

  const start = normalizedBlock.map[matches[0].normalizedIndex];
  const end = normalizedBlock.map[matches[0].normalizedIndex + target.length - 1] + 1;
  return new vscode.Range(document.positionAt(start), document.positionAt(end));
}

function findHtmlRenderedQuoteInAnchoredElement(
  document: vscode.TextDocument,
  quote: string,
  startMeta?: TextAnchorMeta
): vscode.Range | undefined {
  if (!startMeta?.parentTagName || typeof startMeta.parentIndex !== "number" || startMeta.parentIndex < 0) {
    return undefined;
  }

  const element = htmlRenderedElements(document.getText(), startMeta.parentTagName).find((item) => item.tagIndex === startMeta.parentIndex);
  if (!element) return undefined;

  const normalizedElement = normalizeWithMap(element.text, (_, index) => element.map[index]);
  const target = normalizeText(quote);
  if (!target) return undefined;

  const rawPreferredOffset = typeof startMeta.textOffset === "number" ? startMeta.textOffset : undefined;
  const matches: Array<{ normalizedIndex: number; distance: number }> = [];
  let index = normalizedElement.text.indexOf(target);
  while (index !== -1) {
    const sourceOffset = normalizedElement.map[index];
    const rawIndex = element.map.indexOf(sourceOffset);
    const distance = rawPreferredOffset === undefined || rawIndex === -1 ? 0 : Math.abs(rawIndex - rawPreferredOffset);
    matches.push({ normalizedIndex: index, distance });
    index = normalizedElement.text.indexOf(target, index + 1);
  }

  if (matches.length === 0) return undefined;
  matches.sort((a, b) => a.distance - b.distance);

  const start = normalizedElement.map[matches[0].normalizedIndex];
  const end = normalizedElement.map[matches[0].normalizedIndex + target.length - 1] + 1;
  return new vscode.Range(document.positionAt(start), document.positionAt(end));
}

function htmlRenderedElements(source: string, parentTagName: string): MarkdownRenderedBlock[] {
  const tagName = parentTagName.toLowerCase();
  const elements: MarkdownRenderedBlock[] = [];
  const openTag = new RegExp(`<${escapeRegExp(tagName)}(?:\\s[^>]*)?>`, "gi");
  let match: RegExpExecArray | null;
  let tagIndex = 0;

  while ((match = openTag.exec(source))) {
    const contentStart = match.index + match[0].length;
    const closeStart = findHtmlClosingTag(source, tagName, contentStart);
    if (closeStart === -1) continue;

    const visible = htmlVisibleTextWithMap(source.slice(contentStart, closeStart), contentStart);
    elements.push({ tagName: parentTagName.toUpperCase(), tagIndex, text: visible.text, map: visible.map });
    tagIndex += 1;
    openTag.lastIndex = closeStart + tagName.length + 3;
  }

  return elements;
}

function findHtmlClosingTag(source: string, tagName: string, from: number): number {
  const tag = escapeRegExp(tagName);
  const tagPattern = new RegExp(`</?${tag}(?:\\s[^>]*)?>`, "gi");
  tagPattern.lastIndex = from;
  let depth = 1;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(source))) {
    if (match[0][1] === "/") {
      depth -= 1;
      if (depth === 0) return match.index;
    } else {
      depth += 1;
    }
  }

  return -1;
}

function htmlVisibleTextWithMap(fragment: string, sourceOffset: number): { text: string; map: number[] } {
  const output: string[] = [];
  const map: number[] = [];

  const push = (value: string, offsetForValue: number) => {
    for (let index = 0; index < value.length; index += 1) {
      output.push(value[index]);
      map.push(offsetForValue);
    }
  };

  for (let index = 0; index < fragment.length; index += 1) {
    const char = fragment[index];
    if (char === "<") {
      if (fragment.startsWith("<!--", index)) {
        const commentEnd = fragment.indexOf("-->", index + 4);
        if (commentEnd === -1) break;
        index = commentEnd + 2;
        continue;
      }

      const tagEnd = fragment.indexOf(">", index + 1);
      if (tagEnd === -1) break;
      if (/^<\s*br\b/i.test(fragment.slice(index, tagEnd + 1))) {
        push("\n", sourceOffset + index);
      }
      index = tagEnd;
      continue;
    }

    if (char === "&") {
      const decoded = decodeEntityAt(fragment, index);
      if (decoded) {
        push(decoded.value, sourceOffset + index);
        index += decoded.length - 1;
        continue;
      }
    }

    push(char, sourceOffset + index);
  }

  return { text: output.join(""), map };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findRawMatches(text: string, target: string): number[] {
  const matches: number[] = [];
  let index = text.indexOf(target);
  while (index !== -1) {
    matches.push(index);
    index = text.indexOf(target, index + 1);
  }
  return matches;
}

function nearestIndex(indexes: number[], preferredIndex: number | undefined): number {
  if (preferredIndex === undefined) return indexes[0];
  return indexes.reduce((best, index) => (
    Math.abs(index - preferredIndex) < Math.abs(best - preferredIndex) ? index : best
  ), indexes[0]);
}

function sourceOffsetToNormalizedIndex(sourceMap: number[], sourceOffset: number | undefined): number | undefined {
  if (sourceOffset === undefined || sourceMap.length === 0) return undefined;
  let bestIndex = 0;
  let bestDistance = Math.abs(sourceMap[0] - sourceOffset);
  for (let index = 1; index < sourceMap.length; index += 1) {
    const distance = Math.abs(sourceMap[index] - sourceOffset);
    if (distance < bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  }
  return bestIndex;
}

function rootTextOffset(startMeta?: TextAnchorMeta): number | undefined {
  if (typeof startMeta?.textOffset !== "number") return undefined;
  return startMeta.parentIndex === undefined || startMeta.parentIndex === -2 ? startMeta.textOffset : undefined;
}

function hasElementAnchor(startMeta?: TextAnchorMeta): boolean {
  return Boolean(startMeta?.parentTagName && typeof startMeta.parentIndex === "number" && startMeta.parentIndex >= 0);
}

function isMarkdownFile(filePath: string | undefined): boolean {
  return Boolean(filePath && [".md", ".markdown"].includes(path.extname(filePath).toLowerCase()));
}

function uniqueNumbers(values: Array<number | undefined>): number[] {
  return [...new Set(values.filter((value): value is number => typeof value === "number" && Number.isFinite(value)))];
}

function markdownVisibleTextWithMap(source: string): { text: string; map: number[] } {
  const output: string[] = [];
  const map: number[] = [];
  const frontmatterLength = source.match(/^\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/)?.[0].length ?? 0;
  const lines = source.slice(frontmatterLength).split(/(\r?\n)/);
  let offset = frontmatterLength;
  let inFence = false;
  let fenceMarker = "";

  const push = (value: string, sourceOffset: number) => {
    for (let i = 0; i < value.length; i += 1) {
      output.push(value[i]);
      map.push(sourceOffset + i);
    }
  };

  for (let i = 0; i < lines.length; i += 2) {
    const line = lines[i] ?? "";
    const newline = lines[i + 1] ?? "";
    const fence = line.match(/^\s*(`{3,}|~{3,})/);

    if (fence) {
      const marker = fence[1][0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = "";
      }
      if (newline) push("\n", offset + line.length);
      offset += line.length + newline.length;
      continue;
    }

    if (inFence) {
      push(line, offset);
      if (newline) push("\n", offset + line.length);
      offset += line.length + newline.length;
      continue;
    }

    const start = markdownLineContentStart(line);
    appendInlineMarkdown(line.slice(start), offset + start, push);
    if (newline) push("\n", offset + line.length);
    offset += line.length + newline.length;
  }

  return { text: output.join(""), map };
}

type MarkdownRenderedBlock = {
  tagName: string;
  tagIndex: number;
  text: string;
  map: number[];
};

function markdownRenderedBlocks(source: string): MarkdownRenderedBlock[] {
  const blocks: MarkdownRenderedBlock[] = [];
  const tagCounts = new Map<string, number>();
  const frontmatterLength = source.match(/^\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/)?.[0].length ?? 0;
  const lines = source.slice(frontmatterLength).split(/(\r?\n)/);
  let offset = frontmatterLength;
  let inFence = false;
  let fenceMarker = "";
  let paragraph: { text: string[]; map: number[] } | undefined;

  const nextTagIndex = (tagName: string) => {
    const current = tagCounts.get(tagName) ?? 0;
    tagCounts.set(tagName, current + 1);
    return current;
  };

  const addBlock = (tagName: string, text: string[], map: number[]) => {
    if (text.length === 0) return;
    blocks.push({ tagName, tagIndex: nextTagIndex(tagName), text: text.join(""), map });
  };

  const flushParagraph = () => {
    if (!paragraph) return;
    addBlock("P", paragraph.text, paragraph.map);
    paragraph = undefined;
  };

  const pushInline = (line: string, sourceOffset: number, target: { text: string[]; map: number[] }) => {
    appendInlineMarkdown(line, sourceOffset, (value, offsetForValue) => {
      for (let i = 0; i < value.length; i += 1) {
        target.text.push(value[i]);
        target.map.push(offsetForValue + i);
      }
    });
  };

  for (let i = 0; i < lines.length; i += 2) {
    const line = lines[i] ?? "";
    const newline = lines[i + 1] ?? "";
    const fence = line.match(/^\s*(`{3,}|~{3,})/);

    if (fence) {
      flushParagraph();
      const marker = fence[1][0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = "";
      }
      offset += line.length + newline.length;
      continue;
    }

    if (inFence) {
      addBlock("CODE", [...line], Array.from({ length: line.length }, (_, index) => offset + index));
      offset += line.length + newline.length;
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      offset += line.length + newline.length;
      continue;
    }

    const heading = line.match(/^(\s{0,3})(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      const headingLevel = heading[2].length;
      const start = heading[1].length + heading[2].length + 1;
      const target = { text: [] as string[], map: [] as number[] };
      pushInline(line.slice(start), offset + start, target);
      addBlock(`H${headingLevel}`, target.text, target.map);
      offset += line.length + newline.length;
      continue;
    }

    const listStart = markdownListContentStart(line);
    if (listStart !== undefined) {
      flushParagraph();
      const target = { text: [] as string[], map: [] as number[] };
      pushInline(line.slice(listStart), offset + listStart, target);
      addBlock("LI", target.text, target.map);
      offset += line.length + newline.length;
      continue;
    }

    const quoteStart = line.match(/^\s{0,3}>\s?/);
    const start = quoteStart ? quoteStart[0].length : 0;
    if (!paragraph) paragraph = { text: [], map: [] };
    if (paragraph.text.length > 0) {
      paragraph.text.push("\n");
      paragraph.map.push(offset);
    }
    pushInline(line.slice(start), offset + start, paragraph);
    offset += line.length + newline.length;
  }

  flushParagraph();
  return blocks;
}

function markdownRenderedAnchorElements(source: string): MarkdownRenderedBlock[] {
  return [...markdownRenderedBlocks(source), ...markdownRenderedInlineElements(source)];
}

function markdownRenderedInlineElements(source: string): MarkdownRenderedBlock[] {
  const elements: MarkdownRenderedBlock[] = [];
  const tagCounts = new Map<string, number>();
  const frontmatterLength = source.match(/^\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/)?.[0].length ?? 0;
  const lines = source.slice(frontmatterLength).split(/(\r?\n)/);
  let offset = frontmatterLength;
  let inFence = false;
  let fenceMarker = "";

  const addElement = (tagName: string, text: string, sourceOffset: number) => {
    const visible = markdownInlineTextWithMap(text, sourceOffset);
    if (!visible.text) return;
    const tagIndex = tagCounts.get(tagName) ?? 0;
    tagCounts.set(tagName, tagIndex + 1);
    elements.push({ tagName, tagIndex, text: visible.text, map: visible.map });
  };

  for (let i = 0; i < lines.length; i += 2) {
    const line = lines[i] ?? "";
    const newline = lines[i + 1] ?? "";
    const fence = line.match(/^\s*(`{3,}|~{3,})/);

    if (fence) {
      const marker = fence[1][0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = "";
      }
      offset += line.length + newline.length;
      continue;
    }

    if (!inFence) {
      const start = markdownLineContentStart(line);
      collectMarkdownInlineElements(line.slice(start), offset + start, addElement);
    }
    offset += line.length + newline.length;
  }

  return elements;
}

function collectMarkdownInlineElements(line: string, sourceOffset: number, addElement: (tagName: string, text: string, sourceOffset: number) => void): void {
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === "\\" && next) {
      i += 1;
      continue;
    }

    if (char === "!" && next === "[") {
      const parsed = parseMarkdownLink(line, i + 1);
      if (parsed) {
        i = parsed.end;
        continue;
      }
    }

    if (char === "[") {
      const parsed = parseMarkdownLink(line, i);
      if (parsed) {
        addElement("A", parsed.label, sourceOffset + i + 1);
        i = parsed.end;
        continue;
      }
    }

    if ((char === "*" || char === "_") && next === char) {
      const marker = char + char;
      const close = line.indexOf(marker, i + 2);
      if (close !== -1) {
        addElement("STRONG", line.slice(i + 2, close), sourceOffset + i + 2);
        i = close + 1;
        continue;
      }
    }

    if ((char === "*" || char === "_") && next !== char && line[i - 1] !== char) {
      const close = line.indexOf(char, i + 1);
      if (close !== -1 && line[close + 1] !== char) {
        addElement("EM", line.slice(i + 1, close), sourceOffset + i + 1);
        i = close;
      }
    }
  }
}

function markdownInlineTextWithMap(source: string, sourceOffset: number): { text: string; map: number[] } {
  const text: string[] = [];
  const map: number[] = [];
  appendInlineMarkdown(source, sourceOffset, (value, offsetForValue) => {
    for (let i = 0; i < value.length; i += 1) {
      text.push(value[i]);
      map.push(offsetForValue + i);
    }
  });
  return { text: text.join(""), map };
}

function markdownLineContentStart(line: string): number {
  const patterns = [
    /^\s{0,3}#{1,6}\s+/,
    /^\s{0,3}>\s?/,
    /^\s{0,3}[-+*]\s+\[[ xX]\]\s+/,
    /^\s{0,3}(?:[-+*]|\d+[.)])\s+/
  ];
  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (match) return match[0].length;
  }
  return 0;
}

function markdownListContentStart(line: string): number | undefined {
  const task = line.match(/^\s{0,3}[-+*]\s+\[[ xX]\]\s+/);
  if (task) return task[0].length;
  const list = line.match(/^\s{0,3}(?:[-+*]|\d+[.)])\s+/);
  return list ? list[0].length : undefined;
}

function appendInlineMarkdown(line: string, sourceOffset: number, push: (value: string, sourceOffset: number) => void): void {
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === "\\" && next) {
      push(next, sourceOffset + i + 1);
      i += 1;
      continue;
    }

    if (char === "<") {
      const close = line.indexOf(">", i + 1);
      if (close !== -1) {
        i = close;
        continue;
      }
    }

    if (char === "&") {
      const decoded = decodeEntityAt(line, i);
      if (decoded) {
        push(decoded.value, sourceOffset + i);
        i += decoded.length - 1;
        continue;
      }
    }

    if (char === "!" && next === "[") {
      const parsed = parseMarkdownLink(line, i + 1);
      if (parsed) {
        i = parsed.end;
        continue;
      }
    }

    if (char === "[") {
      const parsed = parseMarkdownLink(line, i);
      if (parsed) {
        appendInlineMarkdown(parsed.label, sourceOffset + i + 1, push);
        i = parsed.end;
        continue;
      }
    }

    if (char === "`") {
      const close = line.indexOf("`", i + 1);
      if (close !== -1) {
        push(line.slice(i + 1, close), sourceOffset + i + 1);
        i = close;
        continue;
      }
    }

    if (isMarkdownFormattingChar(char)) {
      continue;
    }

    push(char, sourceOffset + i);
  }
}

function parseMarkdownLink(line: string, openBracket: number): { label: string; end: number } | undefined {
  const closeBracket = line.indexOf("]", openBracket + 1);
  if (closeBracket === -1 || line[closeBracket + 1] !== "(") return undefined;
  const closeParen = line.indexOf(")", closeBracket + 2);
  if (closeParen === -1) return undefined;
  return {
    label: line.slice(openBracket + 1, closeBracket),
    end: closeParen
  };
}

function isMarkdownFormattingChar(char: string): boolean {
  return char === "*" || char === "_" || char === "~";
}

function decodeEntityAt(text: string, index: number): { value: string; length: number } | undefined {
  const semi = text.indexOf(";", index + 1);
  if (semi === -1 || semi - index > 10) return undefined;
  const entity = text.slice(index, semi + 1);
  const named: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": "\"",
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " "
  };
  if (named[entity]) return { value: named[entity], length: entity.length };
  const decimal = entity.match(/^&#(\d+);$/);
  if (decimal) return { value: String.fromCodePoint(Number(decimal[1])), length: entity.length };
  const hex = entity.match(/^&#x([0-9a-f]+);$/i);
  if (hex) return { value: String.fromCodePoint(parseInt(hex[1], 16)), length: entity.length };
  return undefined;
}

function normalizeWithMap(text: string, offsetFor: (char: string, index: number) => number): { text: string; map: number[] } {
  const output: string[] = [];
  const map: number[] = [];
  let previousWasSpace = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (/\s/.test(char)) {
      if (!previousWasSpace && output.length > 0) {
        output.push(" ");
        map.push(offsetFor(char, i));
      }
      previousWasSpace = true;
      continue;
    }

    output.push(char);
    map.push(offsetFor(char, i));
    previousWasSpace = false;
  }

  if (output[output.length - 1] === " ") {
    output.pop();
    map.pop();
  }

  return { text: output.join(""), map };
}

function normalizeText(text: string): string {
  return normalizeWithMap(text, (_, index) => index).text;
}

function oneLine(value: string | undefined, maxLength: number): string {
  const compact = (value ?? "").replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}...` : compact;
}

function commentAuthorName(comment: ShareOneComment): string {
  return comment.user?.username || (comment.author_role === "visitor" ? "anonymous" : comment.author_role);
}

function formatCommentTime(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function getNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return value;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function anchorKind(highlighterData: string | undefined): string {
  const type = commentAnchorType(highlighterData);
  if (type === "region") return "区域评论";
  if (type === "text") return "Text anchor";
  return "Unknown anchor";
}

function commentAnchorType(highlighterData: string | undefined): CommentAnchorType {
  if (!highlighterData) return "unknown";
  try {
    const parsed = JSON.parse(highlighterData) as { anchor_type?: string; startMeta?: unknown };
    if (parsed.anchor_type === "element_point") return "region";
    if (parsed.startMeta) return "text";
  } catch {
    return "unknown";
  }
  return "unknown";
}

type TextAnchorMeta = {
  parentTagName?: string;
  parentIndex?: number;
  textOffset?: number;
};

function parseTextAnchor(highlighterData: string | undefined): { startMeta?: TextAnchorMeta; endMeta?: TextAnchorMeta } | undefined {
  if (!highlighterData) return undefined;
  try {
    const parsed = JSON.parse(highlighterData) as { anchor_type?: string; startMeta?: TextAnchorMeta; endMeta?: TextAnchorMeta };
    if (parsed.anchor_type === "element_point") return undefined;
    if (!parsed.startMeta) return undefined;
    return { startMeta: parsed.startMeta, endMeta: parsed.endMeta };
  } catch {
    return undefined;
  }
}
