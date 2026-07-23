import {
  AddCommentResponse,
  AdfDoc,
  CleanComment,
  CleanJiraIssue,
  JiraCommentResponse,
  SearchIssuesResponse,
} from "../types/jira.js";

export class JiraApiService {
  protected baseUrl: string;
  protected headers: Headers;

  /**
   * Issue fields requested from the search and issue-detail endpoints.
   * Shared so every request asks for the same, minimal payload.
   */
  protected readonly issueFields = [
    "id",
    "key",
    "summary",
    "description",
    "status",
    "created",
    "updated",
    "parent",
    "subtasks",
    "customfield_10014",
    "issuelinks",
  ];

  constructor(baseUrl: string, email: string, apiToken: string, authType: 'basic' | 'bearer' = 'basic') {
    this.baseUrl = baseUrl;
    
    let authHeader: string;
    if (authType === 'bearer') {
      // For Jira Data Center Personal Access Tokens (PATs)
      authHeader = `Bearer ${apiToken}`;
    } else {
      // For Basic authentication with username/password or API token
      const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");
      authHeader = `Basic ${auth}`;
    }
    
    this.headers = new Headers({
      Authorization: authHeader,
      Accept: "application/json",
      "Content-Type": "application/json",
    });
  }

  protected async handleFetchError(
    response: Response,
    url?: string
  ): Promise<never> {
    if (!response.ok) {
      let message = response.statusText;
      let errorData = {};
      try {
        errorData = await response.json();

        if (
          Array.isArray((errorData as any).errorMessages) &&
          (errorData as any).errorMessages.length > 0
        ) {
          message = (errorData as any).errorMessages.join("; ");
        } else if ((errorData as any).message) {
          message = (errorData as any).message;
        } else if ((errorData as any).errorMessage) {
          message = (errorData as any).errorMessage;
        }
      } catch (e) {
        console.warn("Could not parse JIRA error response body as JSON.");
      }

      const details = JSON.stringify(errorData, null, 2);
      console.error("JIRA API Error Details:", details);

      const errorMessage = message ? `: ${message}` : "";
      throw new Error(
        `JIRA API Error${errorMessage} (Status: ${response.status})`
      );
    }

    throw new Error("Unknown error occurred during fetch operation.");
  }

  /**
   * Extracts issue mentions from Atlassian document content
   * Looks for nodes that were auto-converted to issue links
   */
  protected extractIssueMentions(
    content: any[],
    source: "description" | "comment",
    commentId?: string
  ): CleanJiraIssue["relatedIssues"] {
    const mentions: NonNullable<CleanJiraIssue["relatedIssues"]> = [];

    const processNode = (node: any) => {
      if (node.type === "inlineCard" && node.attrs?.url) {
        const match = node.attrs.url.match(/\/browse\/([A-Z]+-\d+)/);
        if (match) {
          mentions.push({
            key: match[1],
            type: "mention",
            source,
            commentId,
          });
        }
      }

      if (node.type === "text" && node.text) {
        const matches = node.text.match(/[A-Z]+-\d+/g) || [];
        matches.forEach((key: string) => {
          mentions.push({
            key,
            type: "mention",
            source,
            commentId,
          });
        });
      }

      if (node.content) {
        node.content.forEach(processNode);
      }
    };

    content.forEach(processNode);
    return [...new Map(mentions.map((m) => [m.key, m])).values()];
  }

  protected cleanComment(comment: {
    id: string;
    body?: {
      content?: any[];
    };
    author?: {
      displayName?: string;
    };
    created: string;
    updated: string;
  }): CleanComment {
    const body = this.parseBody(comment.body);
    const mentions = comment.body?.content
      ? this.extractIssueMentions(comment.body.content, "comment", comment.id)
      : [];

    return {
      id: comment.id,
      body,
      author: comment.author?.displayName,
      created: comment.created,
      updated: comment.updated,
      mentions: mentions,
    };
  }

  /**
   * Recursively extracts text content from Atlassian Document Format nodes
   */
  protected extractTextContent(content: any[]): string {
    if (!Array.isArray(content)) return "";

    return content
      .map((node) => {
        if (node.type === "text") {
          return node.text || "";
        }
        if (node.content) {
          return this.extractTextContent(node.content);
        }
        return "";
      })
      .join("");
  }

  /**
   * Extracts plain text from a comment/description body. Jira Cloud (v3)
   * returns rich text as an ADF document ({ content: [...] }); Jira
   * Server/Data Center (v2) returns it as a plain string. Handles both.
   */
  protected parseBody(body: unknown): string {
    if (typeof body === "string") {
      return body;
    }
    const content = (body as { content?: any[] } | undefined)?.content;
    return content ? this.extractTextContent(content) : "";
  }

  /**
   * Formats plain text for a write payload (comment body, issue
   * description). Jira Cloud (v3) requires an ADF document; Jira
   * Server/Data Center (v2) expects a plain string and overrides this.
   */
  protected formatBody(text: string): AdfDoc | string {
    return this.createAdfFromBody(text);
  }

  /**
   * JQL used to fetch an epic's child issues. Jira Cloud uses the unified
   * `parent` field, which replaces the deprecated "Epic Link" field and
   * covers both team-managed and company-managed projects. Server/Data
   * Center overrides this to use the classic "Epic Link" clause.
   */
  protected epicChildrenJql(epicKey: string): string {
    return `parent = ${epicKey}`;
  }

  protected cleanIssue(issue: any): CleanJiraIssue {
    const description = this.parseBody(issue.fields?.description);

    const cleanedIssue: CleanJiraIssue = {
      id: issue.id,
      key: issue.key,
      summary: issue.fields?.summary,
      status: issue.fields?.status?.name,
      created: issue.fields?.created,
      updated: issue.fields?.updated,
      description,
      relatedIssues: [],
    };

    if (issue.fields?.description?.content) {
      const mentions = this.extractIssueMentions(
        issue.fields.description.content,
        "description"
      );
      if (mentions.length > 0) {
        cleanedIssue.relatedIssues = mentions;
      }
    }

    if (issue.fields?.issuelinks?.length > 0) {
      const links = issue.fields.issuelinks.map((link: any) => {
        const linkedIssue = link.inwardIssue || link.outwardIssue;
        const relationship = link.type.inward || link.type.outward;
        return {
          key: linkedIssue.key,
          summary: linkedIssue.fields?.summary,
          type: "link" as const,
          relationship,
          source: "description" as const,
        };
      });

      cleanedIssue.relatedIssues = [
        ...(cleanedIssue.relatedIssues || []),
        ...links,
      ];
    }

    if (issue.fields?.parent) {
      cleanedIssue.parent = {
        id: issue.fields.parent.id,
        key: issue.fields.parent.key,
        summary: issue.fields.parent.fields?.summary,
      };
    }

    if (issue.fields?.customfield_10014) {
      cleanedIssue.epicLink = {
        id: issue.fields.customfield_10014,
        key: issue.fields.customfield_10014,
        summary: undefined,
      };
    }

    if (issue.fields?.subtasks?.length > 0) {
      cleanedIssue.children = issue.fields.subtasks.map((subtask: any) => ({
        id: subtask.id,
        key: subtask.key,
        summary: subtask.fields?.summary,
      }));
    }

    return cleanedIssue;
  }

  protected async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(this.baseUrl + url, {
      ...init,
      headers: this.headers,
    });

    if (!response.ok) {
      await this.handleFetchError(response, url);
    }

    return response.json();
  }

  /**
   * Runs a JQL search against the enhanced search endpoint
   * (GET /rest/api/3/search/jql). This replaced the removed
   * GET/POST /rest/api/3/search endpoint on Jira Cloud. Pagination is
   * token based (nextPageToken) and the response no longer carries a
   * total count.
   */
  protected async searchJql(
    jql: string,
    maxResults: number
  ): Promise<{ issues: any[]; nextPageToken?: string; isLast?: boolean }> {
    const params = new URLSearchParams({
      jql,
      maxResults: String(maxResults),
      fields: this.issueFields.join(","),
    });

    const data = await this.fetchJson<any>(`/rest/api/3/search/jql?${params}`);

    return {
      issues: data.issues ?? [],
      nextPageToken: data.nextPageToken,
      isLast: data.isLast,
    };
  }

  /**
   * Returns an approximate total issue count for a JQL query using
   * POST /rest/api/3/search/approximate-count. The enhanced search
   * endpoint no longer returns a total, so this is the supported way to
   * obtain a count. Failures are non-fatal and resolve to 0.
   */
  protected async getApproximateCount(jql: string): Promise<number> {
    try {
      const data = await this.fetchJson<{ count?: number }>(
        `/rest/api/3/search/approximate-count`,
        {
          method: "POST",
          body: JSON.stringify({ jql }),
        }
      );
      return data.count ?? 0;
    } catch (error) {
      console.error("Failed to fetch approximate issue count:", error);
      return 0;
    }
  }

  async searchIssues(searchString: string): Promise<SearchIssuesResponse> {
    const [page, total] = await Promise.all([
      this.searchJql(searchString, 50),
      this.getApproximateCount(searchString),
    ]);

    return {
      total,
      issues: page.issues.map((issue: any) => this.cleanIssue(issue)),
    };
  }

  async getEpicChildren(epicKey: string): Promise<CleanJiraIssue[]> {
    const { issues } = await this.searchJql(this.epicChildrenJql(epicKey), 100);

    const issuesWithComments = await Promise.all(
      issues.map(async (issue: any) => {
        const commentsData = await this.fetchJson<any>(
          `/rest/api/3/issue/${issue.key}/comment`
        );
        const cleanedIssue = this.cleanIssue(issue);
        const comments = commentsData.comments.map((comment: any) =>
          this.cleanComment(comment)
        );

        const commentMentions = comments.flatMap(
          (comment: CleanComment) => comment.mentions
        );
        cleanedIssue.relatedIssues = [
          ...cleanedIssue.relatedIssues,
          ...commentMentions,
        ];

        cleanedIssue.comments = comments;
        return cleanedIssue;
      })
    );

    return issuesWithComments;
  }

  async getIssueWithComments(issueId: string): Promise<CleanJiraIssue> {
    const params = new URLSearchParams({
      fields: this.issueFields.join(","),
      expand: "names,renderedFields",
    });

    let issueData, commentsData;
    try {
      [issueData, commentsData] = await Promise.all([
        this.fetchJson<any>(`/rest/api/3/issue/${issueId}?${params}`),
        this.fetchJson<any>(`/rest/api/3/issue/${issueId}/comment`),
      ]);
    } catch (error: any) {
      if (error instanceof Error && error.message.includes("(Status: 404)")) {
        throw new Error(`Issue not found: ${issueId}`);
      }

      throw error;
    }

    const issue = this.cleanIssue(issueData);
    const comments = commentsData.comments.map((comment: any) =>
      this.cleanComment(comment)
    );

    const commentMentions = comments.flatMap(
      (comment: CleanComment) => comment.mentions
    );
    issue.relatedIssues = [...issue.relatedIssues, ...commentMentions];

    issue.comments = comments;

    if (issue.epicLink) {
      try {
        const epicData = await this.fetchJson<any>(
          `/rest/api/3/issue/${issue.epicLink.key}?fields=summary`
        );
        issue.epicLink.summary = epicData.fields?.summary;
      } catch (error) {
        console.error("Failed to fetch epic details:", error);
      }
    }

    return issue;
  }

  async createIssue(
    projectKey: string,
    issueType: string,
    summary: string,
    description?: string,
    fields?: Record<string, any>
  ): Promise<{ id: string; key: string }> {
    const payload = {
      fields: {
        project: {
          key: projectKey,
        },
        summary,
        issuetype: {
          name: issueType,
        },
        ...(description && { description: this.formatBody(description) }),
        ...fields,
      },
    };

    return this.fetchJson<{ id: string; key: string }>("/rest/api/3/issue", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async updateIssue(
    issueKey: string,
    fields: Record<string, any>
  ): Promise<void> {
    await this.fetchJson(`/rest/api/3/issue/${issueKey}`, {
      method: "PUT",
      body: JSON.stringify({ fields }),
    });
  }

  async getTransitions(
    issueKey: string
  ): Promise<Array<{ id: string; name: string; to: { name: string } }>> {
    const data = await this.fetchJson<any>(
      `/rest/api/3/issue/${issueKey}/transitions`
    );
    return data.transitions;
  }

  async transitionIssue(
    issueKey: string,
    transitionId: string,
    comment?: string
  ): Promise<void> {
    const payload: any = {
      transition: { id: transitionId },
    };

    if (comment) {
      payload.update = {
        comment: [{ add: { body: this.formatBody(comment) } }],
      };
    }

    await this.fetchJson(`/rest/api/3/issue/${issueKey}/transitions`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async addAttachment(
    issueKey: string,
    file: Buffer,
    filename: string
  ): Promise<{ id: string; filename: string }> {
    const formData = new FormData();
    // Wrap in a fresh Uint8Array so the Blob part is backed by a plain
    // ArrayBuffer (Node's Buffer can be ArrayBufferLike, which newer
    // @types/node no longer accepts directly as a BlobPart).
    formData.append("file", new Blob([new Uint8Array(file)]), filename);

    const headers = new Headers(this.headers);
    headers.delete("Content-Type");
    headers.set("X-Atlassian-Token", "no-check");

    const response = await fetch(
      `${this.baseUrl}/rest/api/3/issue/${issueKey}/attachments`,
      {
        method: "POST",
        headers,
        body: formData,
      }
    );

    if (!response.ok) {
      await this.handleFetchError(response);
    }

    const data = await response.json();

    const attachment = data[0];
    return {
      id: attachment.id,
      filename: attachment.filename,
    };
  }

  /**
   * Converts plain text to a basic Atlassian Document Format (ADF) structure.
   */
  private createAdfFromBody(text: string): AdfDoc {
    return {
      version: 1,
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: text,
            },
          ],
        },
      ],
    };
  }

  /**
   * Adds a comment to a JIRA issue.
   */
  async addCommentToIssue(
    issueIdOrKey: string,
    body: string
  ): Promise<AddCommentResponse> {
    const payload = {
      body: this.formatBody(body),
    };

    const response = await this.fetchJson<JiraCommentResponse>(
      `/rest/api/3/issue/${issueIdOrKey}/comment`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      }
    );

    return {
      id: response.id,
      author: response.author.displayName,
      created: response.created,
      updated: response.updated,
      body: this.parseBody(response.body),
    };
  }
}
