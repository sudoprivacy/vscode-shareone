import * as vscode from "vscode";
import { ShareOneComment, WorkspaceShare } from "./types";

export type ShareNode = {
  kind: "share";
  share: WorkspaceShare;
};

export type CommentNode = {
  kind: "comment";
  share: WorkspaceShare;
  comment: ShareOneComment;
};

export type TreeNode = ShareNode | CommentNode;

export class CommentsTreeProvider implements vscode.TreeDataProvider<ShareNode> {
  private readonly changed = new vscode.EventEmitter<ShareNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly getShares: () => Promise<WorkspaceShare[]>) {}

  refreshLocal(): void {
    this.changed.fire();
  }

  getTreeItem(element: ShareNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.share.filename, vscode.TreeItemCollapsibleState.None);
    item.contextValue = "shareoneShare";
    item.description = element.share.commentsEnabled ? "comments on" : "comments off";
    item.tooltip = `${element.share.shareUrl}\n${element.share.filePath}`;
    item.iconPath = new vscode.ThemeIcon("link");
    item.command = {
      command: "shareone.openReview",
      title: "Open Review Panel",
      arguments: [element]
    };
    return item;
  }

  async getChildren(element?: ShareNode): Promise<ShareNode[]> {
    if (!element) {
      const shares = await this.getShares();
      if (shares.length === 0) return [];

      const nodes: ShareNode[] = shares.map((share) => ({ kind: "share", share }));
      return nodes.sort((a, b) => timestampFor(b.share) - timestampFor(a.share));
    }

    return [];
  }
}

function timestampFor(share: WorkspaceShare): number {
  const timestamp = Date.parse(share.publishedAt ?? share.updatedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}
