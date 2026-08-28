export type PublishOptions = {
  title?: string;
  password?: string;
  watermark?: string;
  slug?: string;
  allowComments?: boolean;
};

export type PageResponse = {
  share_id: string;
  custom_slug?: string | null;
  share_url: string;
  canonical_url?: string | null;
  custom_slug_warning?: string | null;
  filename: string;
};

export type WorkspaceShare = {
  filePath: string;
  relativePath?: string;
  filename: string;
  shareId: string;
  customSlug?: string | null;
  shareUrl: string;
  canonicalUrl?: string | null;
  contentType: string;
  contentKind: "page" | "file";
  commentsEnabled: boolean;
  publishedAt?: string;
  updatedAt: string;
};

export type SharesFile = {
  version: 1;
  shares: WorkspaceShare[];
};

export type CommentSummary = {
  total: number;
  open: number;
  in_progress: number;
  resolved: number;
  dismissed: number;
  last_activity_at?: string | null;
};

export type ShareOneComment = {
  id: string;
  quote: string;
  highlighter_data: string;
  content: string;
  status: "open" | "in_progress" | "resolved" | "dismissed";
  author_role: "visitor" | "owner" | "agent";
  user?: {
    username: string;
  } | null;
  resolution_note?: string | null;
  created_at: string;
  updated_at?: string | null;
  edited_at?: string | null;
  parent_id?: string | null;
  replies?: ShareOneComment[];
};
