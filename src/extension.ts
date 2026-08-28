import * as path from "path";
import * as crypto from "crypto";
import * as vscode from "vscode";
import { getContentType, isTextShare, ShareOneApi } from "./api";
import { CommentNode, CommentsTreeProvider, ShareNode, TreeNode } from "./commentsTree";
import { ReviewController } from "./reviewController";
import { ShareStorage } from "./storage";
import { PageResponse, PublishOptions, WorkspaceShare } from "./types";

type PendingAuthorization = {
  state: string;
  resolve: (apiKey: string) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
};

class AuthorizationRestartedError extends Error {
  constructor() {
    super("ShareOne authorization was restarted.");
    this.name = "AuthorizationRestartedError";
  }
}

let pendingAuthorization: PendingAuthorization | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const storage = new ShareStorage(context);
  const api = createApi(storage);
  const commentsTree = new CommentsTreeProvider(() => storage.getShares());
  const reviewController = new ReviewController(api, () => commentsTree.refreshLocal(), () => ensureApiKey(storage, context));
  const treeView = vscode.window.createTreeView("shareoneComments", { treeDataProvider: commentsTree });
  context.subscriptions.push(treeView, reviewController, vscode.languages.registerCodeLensProvider({ scheme: "file" }, reviewController));

  context.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri: vscode.Uri): Promise<void> {
        if (!pendingAuthorization) {
          vscode.window.showWarningMessage("ShareOne received an authorization callback, but no authorization is pending.");
          return;
        }

        const params = new URLSearchParams(uri.query);
        const state = params.get("state") || "";
        const code = params.get("code") || "";
        const error = params.get("error") || "";

        if (state !== pendingAuthorization.state) {
          vscode.window.showWarningMessage("ShareOne authorization state did not match. Please try again.");
          return;
        }

        const pending = pendingAuthorization;
        pendingAuthorization = undefined;
        clearTimeout(pending.timer);

        if (error) {
          pending.reject(new Error(error));
          return;
        }
        if (!code) {
          pending.reject(new Error("ShareOne authorization did not return a code."));
          return;
        }

        try {
          const response = await api.exchangeVscodeAuthCode(code, state);
          await storage.setApiKey(response.api_key);
          vscode.window.showInformationMessage(
            response.username
              ? `ShareOne authorized as ${response.username}.`
              : "ShareOne authorization completed."
          );
          pending.resolve(response.api_key);
        } catch (authError) {
          pending.reject(authError);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("shareone.baseUrl")) {
        vscode.window.showInformationMessage("Reload VS Code window to apply the new ShareOne base URL.");
      }
    }),
    vscode.workspace.onDidRenameFiles(async (event) => {
      let changed = false;
      for (const file of event.files) {
        if (await storage.updateFilePath(file.oldUri.fsPath, file.newUri.fsPath)) changed = true;
      }
      if (changed) commentsTree.refreshLocal();
    }),
    vscode.commands.registerCommand("shareone.setApiKey", () => promptAndSaveApiKey(storage)),
    vscode.commands.registerCommand("shareone.clearApiKey", async () => {
      await storage.clearApiKey();
      vscode.window.showInformationMessage("ShareOne API key cleared.");
    }),
    vscode.commands.registerCommand("shareone.publishCurrentFile", (uri?: vscode.Uri) => publishCurrentFile(storage, api, commentsTree, context, uri, false)),
    vscode.commands.registerCommand("shareone.publishWithOptions", (uri?: vscode.Uri) => publishCurrentFile(storage, api, commentsTree, context, uri, true)),
    vscode.commands.registerCommand("shareone.publishOrUpdate", (uri?: vscode.Uri) => publishOrUpdate(storage, api, commentsTree, context, uri)),
    vscode.commands.registerCommand("shareone.updateCurrentShare", (uri?: vscode.Uri) => updateCurrentShare(storage, api, commentsTree, context, uri)),
    vscode.commands.registerCommand("shareone.changeShareSettings", (uri?: vscode.Uri) => changeShareSettings(storage, api, commentsTree, context, uri)),
    vscode.commands.registerCommand("shareone.openReview", (node?: TreeNode) => openReview(reviewController, node)),
    vscode.commands.registerCommand("shareone.openCommentReview", (node?: TreeNode) => openCommentReview(reviewController, node)),
    vscode.commands.registerCommand("shareone.replyComment", (node?: TreeNode) => replyComment(reviewController, node)),
    vscode.commands.registerCommand("shareone.resolveComment", (node?: TreeNode) => resolveComment(reviewController, node)),
    vscode.commands.registerCommand("shareone.openManage", () => openManage()),
    vscode.commands.registerCommand("shareone.openShare", (node?: TreeNode) => openShare(node)),
    vscode.commands.registerCommand("shareone.copyShareUrl", (node?: TreeNode) => copyShareUrl(node))
  );
}

export function deactivate(): void {}

async function promptAndSaveApiKey(storage: ShareStorage): Promise<boolean> {
  const apiKey = await vscode.window.showInputBox({
    title: "ShareOne API Key",
    prompt: "Paste your ShareOne API key from https://shareone.vip/settings",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : "API key is required")
  });
  if (!apiKey) return false;
  await storage.setApiKey(apiKey.trim());
  vscode.window.showInformationMessage("ShareOne API key saved.");
  return true;
}

async function ensureApiKey(storage: ShareStorage, context: vscode.ExtensionContext): Promise<boolean> {
  const existing = await storage.getApiKey();
  if (existing?.trim()) return true;

  const action = await vscode.window.showInformationMessage(
    "ShareOne needs browser authorization before continuing from VS Code.",
    { modal: true },
    "网页登录授权"
  );
  if (action !== "网页登录授权") return false;

  try {
    const apiKey = await authorizeWithShareOne(context);
    return Boolean(apiKey);
  } catch (error) {
    if (isAuthorizationRestartedError(error)) return false;
    throw error;
  }
}

async function authorizeWithShareOne(context: vscode.ExtensionContext): Promise<string | undefined> {
  if (pendingAuthorization) {
    const previous = pendingAuthorization;
    pendingAuthorization = undefined;
    clearTimeout(previous.timer);
    previous.reject(new AuthorizationRestartedError());
  }

  const state = crypto.randomBytes(24).toString("hex");
  const callbackUri = await vscode.env.asExternalUri(
    vscode.Uri.parse(`${vscode.env.uriScheme}://${context.extension.id}/auth-callback`)
  );
  const authUrl = new URL(`${getBaseUrl().replace(/\/+$/, "")}/vscode-auth`);
  authUrl.searchParams.set("callback_uri", callbackUri.toString());
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("source", "vscode");

  const result = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingAuthorization?.state === state) {
        pendingAuthorization = undefined;
      }
      reject(new Error("ShareOne authorization timed out. Please try again."));
    }, 5 * 60 * 1000);
    pendingAuthorization = { state, resolve, reject, timer };
  });

  const authUri = vscode.Uri.parse(authUrl.toString());
  const opened = await vscode.env.openExternal(authUri);
  if (!opened) {
    const pending = pendingAuthorization as PendingAuthorization | undefined;
    if (pending?.state === state) {
      clearTimeout(pending.timer);
      pendingAuthorization = undefined;
    }
    const action = await vscode.window.showErrorMessage(
      "Could not open ShareOne authorization page in your browser.",
      "Copy Authorization Link"
    );
    if (action === "Copy Authorization Link") {
      await vscode.env.clipboard.writeText(authUrl.toString());
    }
    throw new Error("Could not open ShareOne authorization page in your browser.");
  }
  void vscode.window
    .showInformationMessage("Complete ShareOne authorization in your browser to continue.", "Open Again", "Copy Link")
    .then(async (action) => {
      if (action === "Open Again") await vscode.env.openExternal(authUri);
      if (action === "Copy Link") await vscode.env.clipboard.writeText(authUrl.toString());
    });
  return result;
}

async function publishCurrentFile(
  storage: ShareStorage,
  api: ShareOneApi,
  commentsTree: CommentsTreeProvider,
  context: vscode.ExtensionContext,
  uri: vscode.Uri | undefined,
  withOptions: boolean
): Promise<void> {
  try {
    const fileUri = await resolveFileUri(uri);
    if (!fileUri) return;
    if (!ensureWorkspaceFolder()) return;
    if (!(await ensureApiKey(storage, context))) return;

    const options = withOptions ? await promptPublishOptions() : { allowComments: true };
    if (!options) return;

    let publishResponse: PageResponse | undefined;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Publishing to ShareOne..." },
      async () => {
        const { response, contentType, contentKind } = await api.publish(fileUri, options);
        publishResponse = response;
        const now = new Date().toISOString();
        const share: WorkspaceShare = {
          filePath: fileUri.fsPath,
          filename: response.filename || path.basename(fileUri.fsPath),
          shareId: response.share_id,
          customSlug: response.custom_slug,
          shareUrl: response.share_url,
          canonicalUrl: response.canonical_url,
          contentType,
          contentKind,
          commentsEnabled: Boolean(options.allowComments && contentKind === "page"),
          publishedAt: now,
          updatedAt: now
        };
        await storage.saveShare(share);
        commentsTree.refreshLocal();
        await vscode.env.clipboard.writeText(response.share_url);
      }
    );
    if (!publishResponse) return;
    const action = await vscode.window.showInformationMessage("ShareOne link copied to clipboard.", "Open", "Manage");
    if (action === "Open") await vscode.env.openExternal(vscode.Uri.parse(publishResponse.share_url));
    if (action === "Manage") await vscode.env.openExternal(vscode.Uri.parse(`${getBaseUrl()}/manage`));
    if (publishResponse.custom_slug_warning) vscode.window.showWarningMessage(publishResponse.custom_slug_warning);
  } catch (error) {
    showError(error);
  }
}

async function publishOrUpdate(
  storage: ShareStorage,
  api: ShareOneApi,
  commentsTree: CommentsTreeProvider,
  context: vscode.ExtensionContext,
  uri?: vscode.Uri
): Promise<void> {
  try {
    const fileUri = await resolveFileUri(uri);
    if (!fileUri) return;
    if (!ensureWorkspaceFolder()) return;
    if (!(await ensureApiKey(storage, context))) return;

    const existing = await storage.findShareByFile(fileUri.fsPath);
    if (!existing) {
      const action = await vscode.window.showQuickPick(
        [
          { label: "Publish With Options", value: "publish-options" },
          { label: "Publish Current File", value: "publish" }
        ],
        { title: "ShareOne" }
      );
      if (!action) return;
      if (action.value === "publish-options") return publishCurrentFile(storage, api, commentsTree, context, fileUri, true);
      return publishCurrentFile(storage, api, commentsTree, context, fileUri, false);
    }

    const action = await vscode.window.showQuickPick(
      [
        { label: "Update Existing Share", value: "update" },
        { label: "Change Share Settings", value: "settings" },
        { label: "Open Share", value: "open" },
        { label: "Copy Share URL", value: "copy" },
        { label: "Publish As New Share", value: "publish-options" }
      ],
      { title: `ShareOne: ${existing.filename}` }
    );
    if (!action) return;

    if (action.value === "update") return updateCurrentShare(storage, api, commentsTree, context, fileUri);
    if (action.value === "settings") return changeShareSettings(storage, api, commentsTree, context, fileUri);
    if (action.value === "open") {
      await vscode.env.openExternal(vscode.Uri.parse(existing.shareUrl));
      return;
    }
    if (action.value === "copy") {
      await vscode.env.clipboard.writeText(existing.shareUrl);
      vscode.window.showInformationMessage("ShareOne link copied.");
      return;
    }
    return publishCurrentFile(storage, api, commentsTree, context, fileUri, true);
  } catch (error) {
    showError(error);
  }
}

async function updateCurrentShare(
  storage: ShareStorage,
  api: ShareOneApi,
  commentsTree: CommentsTreeProvider,
  context: vscode.ExtensionContext,
  uri?: vscode.Uri
): Promise<void> {
  try {
    const fileUri = await resolveFileUri(uri);
    if (!fileUri) return;
    if (!ensureWorkspaceFolder()) return;
    if (!(await ensureApiKey(storage, context))) return;

    const existing = await storage.findShareByFile(fileUri.fsPath);
    if (!existing) {
      vscode.window.showWarningMessage("This file has not been published by ShareOne in this workspace yet.");
      return;
    }

    if (!isTextShare(fileUri.fsPath, getContentType(fileUri.fsPath))) {
      vscode.window.showWarningMessage("Updating existing binary shares is not supported yet. Publish it as a new ShareOne link.");
      return;
    }

    let updateResponse: PageResponse | undefined;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Updating ShareOne link..." },
      async () => {
        const response = await api.updateTextShare(existing.shareId, fileUri, { allowComments: existing.commentsEnabled });
        updateResponse = response;
        await storage.saveShare({
          ...existing,
          filename: response.filename || existing.filename,
          customSlug: response.custom_slug,
          shareUrl: response.share_url,
          canonicalUrl: response.canonical_url,
          updatedAt: new Date().toISOString()
        });
        commentsTree.refreshLocal();
      }
    );
    if (!updateResponse) return;
    const action = await vscode.window.showInformationMessage("ShareOne link updated.", "Open", "Copy Link");
    if (action === "Open") await vscode.env.openExternal(vscode.Uri.parse(updateResponse.share_url));
    if (action === "Copy Link") await vscode.env.clipboard.writeText(updateResponse.share_url);
  } catch (error) {
    showError(error);
  }
}

async function changeShareSettings(
  storage: ShareStorage,
  api: ShareOneApi,
  commentsTree: CommentsTreeProvider,
  context: vscode.ExtensionContext,
  uri?: vscode.Uri
): Promise<void> {
  try {
    const fileUri = await resolveFileUri(uri);
    if (!fileUri) return;
    if (!ensureWorkspaceFolder()) return;

    const existing = await storage.findShareByFile(fileUri.fsPath);
    if (!existing) {
      vscode.window.showWarningMessage("This file has not been published by ShareOne in this workspace yet.");
      return;
    }
    if (!(await ensureApiKey(storage, context))) return;

    const options = await promptPublishOptions("ShareOne Share Settings", existing.contentKind === "page");
    if (!options) return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Updating ShareOne settings..." },
      async () => {
        const response = await api.updateShareSettings(existing.shareId, existing.contentKind, options);
        const updatedShare: WorkspaceShare = {
          ...existing,
          filename: response.filename || existing.filename,
          customSlug: response.custom_slug,
          shareUrl: response.share_url,
          canonicalUrl: response.canonical_url,
          commentsEnabled: existing.contentKind === "page" ? Boolean(options.allowComments) : existing.commentsEnabled,
          updatedAt: new Date().toISOString()
        };
        await storage.saveShare(updatedShare);
        commentsTree.refreshLocal();
        vscode.window.showInformationMessage("ShareOne settings updated.");
      }
    );
  } catch (error) {
    showError(error);
  }
}

async function openReview(reviewController: ReviewController, node?: TreeNode): Promise<void> {
  const shareNode = asShareNode(node);
  if (!shareNode) return;
  try {
    await reviewController.openReview(shareNode.share);
  } catch (error) {
    showError(error);
  }
}

async function openCommentReview(reviewController: ReviewController, node?: TreeNode): Promise<void> {
  const commentNode = asCommentNode(node);
  if (!commentNode) return;
  try {
    await reviewController.openComment({ share: commentNode.share, comment: commentNode.comment });
  } catch (error) {
    showError(error);
  }
}

async function replyComment(reviewController: ReviewController, node?: TreeNode): Promise<void> {
  const commentNode = asCommentNode(node);
  if (!commentNode) return;
  try {
    await reviewController.replyToComment(commentNode.share, commentNode.comment);
  } catch (error) {
    showError(error);
  }
}

async function resolveComment(reviewController: ReviewController, node?: TreeNode): Promise<void> {
  const commentNode = asCommentNode(node);
  if (!commentNode) return;
  try {
    await reviewController.resolveComment(commentNode.share, commentNode.comment);
  } catch (error) {
    showError(error);
  }
}

async function openManage(): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(`${getBaseUrl().replace(/\/+$/, "")}/manage`));
}

async function openShare(node?: TreeNode): Promise<void> {
  const share = node?.kind === "share" ? node.share : node?.kind === "comment" ? node.share : undefined;
  if (!share) return;
  await vscode.env.openExternal(vscode.Uri.parse(share.shareUrl));
}

async function copyShareUrl(node?: TreeNode): Promise<void> {
  const share = node?.kind === "share" ? node.share : node?.kind === "comment" ? node.share : undefined;
  if (!share) return;
  await vscode.env.clipboard.writeText(share.shareUrl);
  vscode.window.showInformationMessage("ShareOne link copied.");
}

async function promptPublishOptions(title = "ShareOne Publish Options", showComments = true): Promise<PublishOptions | undefined> {
  const panel = vscode.window.createWebviewPanel(
    "shareonePublishOptions",
    title,
    vscode.ViewColumn.Active,
    { enableScripts: true }
  );

  const nonce = getNonce();
  panel.webview.html = getPublishOptionsHtml(nonce, title, showComments);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (options: PublishOptions | undefined) => {
      if (settled) return;
      settled = true;
      resolve(options);
      panel.dispose();
    };

    const subscription = panel.webview.onDidReceiveMessage((message: PublishOptionsMessage) => {
      if (message.command === "cancel") {
        finish(undefined);
        return;
      }
      if (message.command === "publish") {
        finish({
          title: message.title.trim() || undefined,
          password: message.password.trim() || undefined,
          watermark: message.watermark.trim() || undefined,
          slug: message.slug.trim() || undefined,
          allowComments: showComments ? message.allowComments : undefined
        });
      }
    });

    panel.onDidDispose(() => {
      subscription.dispose();
      finish(undefined);
    });
  });
}

async function resolveFileUri(uri?: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (uri?.scheme === "file") return uri;
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === "file") return active;
  vscode.window.showWarningMessage("Open a local file before running ShareOne publish.");
  return undefined;
}

function ensureWorkspaceFolder(): boolean {
  if (vscode.workspace.workspaceFolders?.length) return true;
  vscode.window.showWarningMessage("Open a workspace folder before using ShareOne file bindings.");
  return false;
}

type PublishOptionsMessage =
  | {
      command: "publish";
      title: string;
      password: string;
      watermark: string;
      slug: string;
      allowComments: boolean;
    }
  | { command: "cancel" };

function getPublishOptionsHtml(nonce: string, title: string, showComments: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light dark;
    }
    body {
      margin: 0;
      padding: 24px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    main {
      max-width: 560px;
    }
    h1 {
      margin: 0 0 20px;
      font-size: 20px;
      font-weight: 600;
    }
    form {
      display: grid;
      gap: 16px;
    }
    label {
      display: grid;
      gap: 6px;
      font-weight: 600;
    }
    input[type="text"],
    input[type="password"] {
      height: 32px;
      box-sizing: border-box;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      padding: 4px 8px;
      font: inherit;
    }
    input:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .hint {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      font-weight: 400;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .row label {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 400;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 8px;
    }
    button {
      min-width: 88px;
      height: 32px;
      border: 1px solid var(--vscode-button-border, transparent);
      font: inherit;
      cursor: pointer;
    }
    button.primary {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    button.primary:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <form id="form">
      <label>
        Title
        <input id="title" type="text" autocomplete="off" placeholder="Optional share title">
      </label>
      <label>
        Access password
        <input id="password" type="password" autocomplete="new-password" placeholder="Optional">
      </label>
      <label>
        Watermark
        <input id="watermark" type="text" autocomplete="off" placeholder="Optional">
      </label>
      <label>
        Custom slug
        <input id="slug" type="text" autocomplete="off" pattern="[a-z0-9-]{3,64}" placeholder="product-demo">
        <span class="hint">Lowercase letters, numbers, and hyphens. Leave empty to auto-generate.</span>
      </label>
      ${
        showComments
          ? `<div class="row">
        <label>
          <input id="allowComments" type="checkbox" checked>
          Enable comments
        </label>
      </div>`
          : ""
      }
      <div class="actions">
        <button class="secondary" id="cancel" type="button">Cancel</button>
        <button class="primary" type="submit">Publish</button>
      </div>
    </form>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const form = document.getElementById("form");
    const cancel = document.getElementById("cancel");

    cancel.addEventListener("click", () => {
      vscode.postMessage({ command: "cancel" });
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      vscode.postMessage({
        command: "publish",
        title: document.getElementById("title").value,
        password: document.getElementById("password").value,
        watermark: document.getElementById("watermark").value,
        slug: document.getElementById("slug").value,
        allowComments: document.getElementById("allowComments") ? document.getElementById("allowComments").checked : false
      });
    });
  </script>
</body>
</html>`;
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

function asShareNode(node?: TreeNode): ShareNode | undefined {
  if (node?.kind === "share") return node;
  if (node?.kind === "comment") return { kind: "share", share: node.share };
  vscode.window.showWarningMessage("Select a ShareOne share first.");
  return undefined;
}

function asCommentNode(node?: TreeNode): CommentNode | undefined {
  if (node?.kind === "comment") return node;
  vscode.window.showWarningMessage("Select a ShareOne comment first.");
  return undefined;
}

function createApi(storage: ShareStorage): ShareOneApi {
  return new ShareOneApi(getBaseUrl(), () => storage.getApiKey());
}

function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("shareone");
}

function getBaseUrl(): string {
  return getConfig().get<string>("baseUrl", "https://shareone.vip");
}

function showError(error: unknown): void {
  if (isAuthorizationRestartedError(error)) return;
  const message = error instanceof Error ? error.message : String(error);
  vscode.window.showErrorMessage(`ShareOne: ${message}`);
}

function isAuthorizationRestartedError(error: unknown): boolean {
  return error instanceof AuthorizationRestartedError
    || (error instanceof Error && error.name === "AuthorizationRestartedError");
}
