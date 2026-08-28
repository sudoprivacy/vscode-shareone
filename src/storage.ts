import * as path from "path";
import * as vscode from "vscode";
import { SharesFile, WorkspaceShare } from "./types";

const SHARES_KEY = "shareone.workspaceShares";
const API_KEY_SECRET = "shareone.apiKey";

export class ShareStorage {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async getShares(): Promise<WorkspaceShare[]> {
    const file = await this.readSharesFile();
    if (file) return file.shares.map((share) => this.hydrateShare(share));

    const legacy = this.context.workspaceState.get<WorkspaceShare[]>(SHARES_KEY, []);
    if (legacy.length > 0) {
      const migrated = legacy.map((share) => this.prepareShare(share));
      await this.writeShares(migrated);
      await this.context.workspaceState.update(SHARES_KEY, undefined);
      return migrated;
    }

    return [];
  }

  async saveShare(share: WorkspaceShare): Promise<void> {
    const prepared = this.prepareShare(share);
    const shares = await this.getShares();
    const index = shares.findIndex((item) => item.relativePath === prepared.relativePath || item.filePath === prepared.filePath);
    if (index === -1) {
      shares.push(prepared);
    } else {
      shares[index] = prepared;
    }
    await this.writeShares(shares);
  }

  async findShareByFile(filePath: string): Promise<WorkspaceShare | undefined> {
    const targetRelativePath = this.toRelativePath(filePath);
    const shares = await this.getShares();
    return shares.find((share) => {
      if (share.filePath === filePath) return true;
      return Boolean(targetRelativePath && share.relativePath === targetRelativePath);
    });
  }

  async updateFilePath(oldFilePath: string, newFilePath: string): Promise<boolean> {
    const shares = await this.getShares();
    const oldRelativePath = this.toRelativePath(oldFilePath);
    const index = shares.findIndex((share) => share.filePath === oldFilePath || Boolean(oldRelativePath && share.relativePath === oldRelativePath));
    if (index === -1) return false;

    shares[index] = this.prepareShare({
      ...shares[index],
      filePath: newFilePath,
      filename: path.basename(newFilePath),
      publishedAt: shares[index].publishedAt ?? shares[index].updatedAt,
      updatedAt: new Date().toISOString()
    });
    await this.writeShares(shares);
    return true;
  }

  async getApiKey(): Promise<string | undefined> {
    return this.context.secrets.get(API_KEY_SECRET);
  }

  async setApiKey(apiKey: string): Promise<void> {
    await this.context.secrets.store(API_KEY_SECRET, apiKey);
  }

  async clearApiKey(): Promise<void> {
    await this.context.secrets.delete(API_KEY_SECRET);
  }

  private async readSharesFile(): Promise<SharesFile | undefined> {
    const uri = this.sharesFileUri();
    if (!uri) return undefined;

    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as Partial<SharesFile>;
      if (!Array.isArray(parsed.shares)) return { version: 1, shares: [] };
      return { version: 1, shares: parsed.shares };
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") return undefined;
      return undefined;
    }
  }

  private async writeShares(shares: WorkspaceShare[]): Promise<void> {
    const uri = this.sharesFileUri();
    const folder = this.sharesFolderUri();
    if (!uri || !folder) {
      throw new Error("Open a workspace folder before saving ShareOne bindings.");
    }

    await vscode.workspace.fs.createDirectory(folder);
    const payload: SharesFile = { version: 1, shares: shares.map((share) => this.prepareShare(share)) };
    await vscode.workspace.fs.writeFile(uri, Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8"));
  }

  private hydrateShare(share: WorkspaceShare): WorkspaceShare {
    if (share.relativePath) {
      const folder = this.workspaceFolder();
      if (folder) {
        return { ...share, filePath: path.join(folder.uri.fsPath, share.relativePath) };
      }
    }
    return this.prepareShare(share);
  }

  private prepareShare(share: WorkspaceShare): WorkspaceShare {
    return {
      ...share,
      filePath: share.filePath,
      publishedAt: share.publishedAt ?? share.updatedAt,
      relativePath: share.relativePath ?? this.toRelativePath(share.filePath)
    };
  }

  private toRelativePath(filePath: string): string | undefined {
    const folder = this.workspaceFolder();
    if (!folder) return undefined;
    return path.relative(folder.uri.fsPath, filePath).split(path.sep).join("/");
  }

  private sharesFileUri(): vscode.Uri | undefined {
    const folder = this.sharesFolderUri();
    return folder ? vscode.Uri.joinPath(folder, "shares.json") : undefined;
  }

  private sharesFolderUri(): vscode.Uri | undefined {
    const folder = this.workspaceFolder();
    return folder ? vscode.Uri.joinPath(folder.uri, ".shareone") : undefined;
  }

  private workspaceFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
  }
}
