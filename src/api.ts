import * as path from "path";
import * as vscode from "vscode";
import { CommentSummary, PageResponse, PublishOptions, ShareOneComment } from "./types";

const TEXT_EXTENSIONS = new Set([".html", ".htm", ".md", ".markdown", ".txt"]);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".pdf": "application/pdf",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".zip": "application/zip"
};

export function getContentType(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function isTextShare(filePath: string, contentType = getContentType(filePath)): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || contentType === "text/html" || contentType === "text/markdown" || contentType === "text/plain";
}

export class ShareOneApi {
  constructor(private readonly baseUrl: string, private readonly apiKeyProvider: () => Promise<string | undefined>) {}

  async exchangeVscodeAuthCode(code: string, state: string): Promise<{ api_key: string; username?: string }> {
    return this.requestJson<{ api_key: string; username?: string }>("/api/v1/auth/vscode/exchange", {
      method: "POST",
      auth: false,
      body: { code, state }
    });
  }

  async publish(uri: vscode.Uri, options: PublishOptions): Promise<{ response: PageResponse; contentType: string; contentKind: "page" | "file" }> {
    const contentType = getContentType(uri.fsPath);
    if (isTextShare(uri.fsPath, contentType)) {
      const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
      const response = await this.requestJson<PageResponse>("/api/v1/pages", {
        method: "POST",
        auth: true,
        body: {
          filename: path.basename(uri.fsPath),
          html_content: content,
          title: options.title || undefined,
          password: options.password || undefined,
          watermark: options.watermark || undefined,
          custom_slug: options.slug || undefined,
          allow_comments: options.allowComments,
          publish_source: "vscode"
        }
      });
      return { response, contentType, contentKind: "page" };
    }

    const form = new FormData();
    const bytes = await vscode.workspace.fs.readFile(uri);
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    form.append("file", new Blob([arrayBuffer], { type: contentType }), path.basename(uri.fsPath));
    if (options.password) form.append("password", options.password);
    if (options.watermark) form.append("watermark", options.watermark);
    if (options.slug) form.append("custom_slug", options.slug);
    form.append("publish_source", "vscode");

    const response = await this.requestJson<PageResponse>("/api/v1/files", {
      method: "POST",
      auth: true,
      body: form
    });
    return { response, contentType, contentKind: "file" };
  }

  async updateTextShare(shareId: string, uri: vscode.Uri, options: Pick<PublishOptions, "allowComments"> = {}): Promise<PageResponse> {
    const contentType = getContentType(uri.fsPath);
    if (!isTextShare(uri.fsPath, contentType)) {
      throw new Error("Updating existing binary shares is not supported by this extension yet.");
    }

    const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    return this.requestJson<PageResponse>(`/api/v1/pages/${encodeURIComponent(shareId)}`, {
      method: "PUT",
      auth: true,
      body: {
        filename: path.basename(uri.fsPath),
        html_content: content,
        allow_comments: options.allowComments
      }
    });
  }

  async updateShareSettings(
    shareId: string,
    contentKind: "page" | "file",
    options: PublishOptions
  ): Promise<PageResponse> {
    const body: Record<string, unknown> = {
      title: options.title || undefined,
      password: options.password,
      watermark: options.watermark,
      custom_slug: options.slug || undefined
    };
    if (contentKind === "page") {
      body.allow_comments = options.allowComments;
    }

    const endpoint = contentKind === "page" ? "/api/v1/pages" : "/api/v1/files";
    return this.requestJson<PageResponse>(`${endpoint}/${encodeURIComponent(shareId)}`, {
      method: "PUT",
      auth: true,
      body
    });
  }

  async getCommentSummary(shareId: string): Promise<CommentSummary> {
    return this.requestJson<CommentSummary>(`/api/v1/shares/${encodeURIComponent(shareId)}/comments/summary`, {
      method: "GET",
      auth: false
    });
  }

  async listComments(shareId: string, status = "unresolved"): Promise<ShareOneComment[]> {
    return this.requestJson<ShareOneComment[]>(
      `/api/v1/shares/${encodeURIComponent(shareId)}/comments?status=${encodeURIComponent(status)}`,
      { method: "GET", auth: false }
    );
  }

  async updateCommentStatus(shareId: string, commentId: string, status: ShareOneComment["status"], note?: string): Promise<ShareOneComment> {
    return this.requestJson<ShareOneComment>(
      `/api/v1/shares/${encodeURIComponent(shareId)}/comments/${encodeURIComponent(commentId)}/status`,
      {
        method: "PUT",
        auth: true,
        body: { status, note }
      }
    );
  }

  async replyToComment(shareId: string, commentId: string, content: string): Promise<ShareOneComment> {
    return this.requestJson<ShareOneComment>(`/api/v1/shares/${encodeURIComponent(shareId)}/comments`, {
      method: "POST",
      auth: true,
      body: {
        parent_id: commentId,
        content
      }
    });
  }

  private async requestJson<T>(
    apiPath: string,
    options: {
      method: "GET" | "POST" | "PUT";
      auth: boolean;
      body?: unknown;
    }
  ): Promise<T> {
    const headers: Record<string, string> = {};
    let body: BodyInit | undefined;

    if (options.auth) {
      const apiKey = await this.apiKeyProvider();
      if (!apiKey) {
        throw new Error("ShareOne authorization is required for this action.");
      }
      headers["X-API-Key"] = apiKey;
    }

    if (options.body instanceof FormData) {
      body = options.body;
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(this.buildUrl(apiPath), {
      method: options.method,
      headers,
      body
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(this.formatError(response.status, text));
    }

    if (!text) {
      return undefined as T;
    }

    return JSON.parse(text) as T;
  }

  private buildUrl(apiPath: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}${apiPath}`;
  }

  private formatError(status: number, text: string): string {
    if (!text) {
      return `ShareOne request failed with HTTP ${status}.`;
    }
    try {
      const parsed = JSON.parse(text) as { detail?: unknown; message?: string };
      if (typeof parsed.detail === "string") return parsed.detail;
      if (parsed.detail && typeof parsed.detail === "object" && "message" in parsed.detail) {
        return String((parsed.detail as { message?: unknown }).message);
      }
      if (parsed.message) return parsed.message;
    } catch {
      // Fall through to raw body.
    }
    return `ShareOne request failed with HTTP ${status}: ${text.slice(0, 300)}`;
  }
}
