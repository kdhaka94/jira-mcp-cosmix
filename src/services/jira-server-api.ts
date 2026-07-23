// JiraServerApiService: Jira Server (Data Center) implementation
// This class should override methods as needed for Jira Server differences
import { JiraApiService } from "./jira-api.js";

export class JiraServerApiService extends JiraApiService {
  constructor(baseUrl: string, email: string, apiToken: string, authType: 'basic' | 'bearer' = 'basic') {
    // For Jira Server/Data Center:
    // - Basic Auth: username/password or API token (traditional method)
    // - Bearer Auth: Personal Access Tokens (PATs) available in Data Center 8.14.0+
    super(baseUrl, email, apiToken, authType);
  }

  // Example: Override fetchJson to use /rest/api/2/ instead of /rest/api/3/
  protected overrideApiPath(path: string): string {
    // Replace /rest/api/3/ with /rest/api/2/ for Jira Server
    return path.replace("/rest/api/3/", "/rest/api/2/");
  }

  // Override fetchJson to use the correct API path
  protected async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const serverUrl = this.overrideApiPath(url);
    return super.fetchJson<T>(serverUrl, init);
  }

  // Jira Server/Data Center is not affected by the Jira Cloud deprecation of
  // the classic search endpoint and does not provide the enhanced
  // /rest/api/2/search/jql or /rest/api/2/search/approximate-count endpoints.
  // The classic /rest/api/2/search endpoint (startAt/total pagination) remains
  // the correct choice there, so the search transport is overridden to use it.
  protected async searchJql(
    jql: string,
    maxResults: number,
  ): Promise<{ issues: any[]; nextPageToken?: string; isLast?: boolean }> {
    const params = new URLSearchParams({
      jql,
      maxResults: String(maxResults),
      startAt: "0",
      fields: this.issueFields.join(","),
    });

    // Call the classic endpoint directly, bypassing the v3 -> v2 rewrite.
    const data = await super.fetchJson<any>(`/rest/api/2/search?${params}`);

    const returned = (data.startAt ?? 0) + (data.issues?.length ?? 0);
    return {
      issues: data.issues ?? [],
      isLast:
        typeof data.total === "number" ? returned >= data.total : undefined,
    };
  }

  protected async getApproximateCount(jql: string): Promise<number> {
    try {
      const params = new URLSearchParams({ jql, maxResults: "0" });
      const data = await super.fetchJson<any>(`/rest/api/2/search?${params}`);
      return typeof data.total === "number" ? data.total : 0;
    } catch (error) {
      console.error("Failed to fetch issue count:", error);
      return 0;
    }
  }
}
