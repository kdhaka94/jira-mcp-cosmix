import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { JiraServerApiService } from "../jira-server-api.js";

describe("JiraServerApiService", () => {
  const baseUrl = "https://jira.example.com";
  const apiToken = "test-token";
  const email = "user@domain.net";
  let service: JiraServerApiService;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    service = new JiraServerApiService(baseUrl, email, apiToken);
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("searchIssues", () => {
    const mockResponse = {
      startAt: 0,
      total: 2,
      issues: [
        {
          id: "1",
          key: "TEST-1",
          fields: {
            summary: "Server Issue",
            status: { name: "Open" },
            created: "2024-01-01T00:00:00.000Z",
            updated: "2024-01-01T00:00:00.000Z",
          },
        },
      ],
    };

    test("uses the classic /rest/api/2/search endpoint, not the Cloud /search/jql endpoint", async () => {
      const requestedUrls: string[] = [];
      const mockFetch = async (input: RequestInfo | URL) => {
        const url = input.toString();
        requestedUrls.push(url);
        if (url.includes("maxResults=0")) {
          // Approximate-count call resolves to the classic total.
          return new Response(JSON.stringify({ total: mockResponse.total }));
        }
        return new Response(JSON.stringify(mockResponse));
      };
      mockFetch.preconnect = async () => {};
      global.fetch = mockFetch;

      const result = await service.searchIssues("project = TEST");

      expect(result.total).toBe(2);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].key).toBe("TEST-1");

      // Classic endpoint is used on Server/DC ...
      expect(
        requestedUrls.every((u) => u.includes("/rest/api/2/search")),
      ).toBe(true);
      // ... and the Cloud-only enhanced endpoints are never called.
      expect(requestedUrls.some((u) => u.includes("/search/jql"))).toBe(false);
      expect(
        requestedUrls.some((u) => u.includes("/search/approximate-count")),
      ).toBe(false);
    });

    test("propagates classic search errors", async () => {
      const mockFetch = async () =>
        new Response(
          JSON.stringify({ errorMessages: ["You do not have permission"] }),
          { status: 403 },
        );
      mockFetch.preconnect = async () => {};
      global.fetch = mockFetch;

      await expect(service.searchIssues("project = TEST")).rejects.toThrow(
        "JIRA API Error: You do not have permission",
      );
    });
  });

  describe("getEpicChildren", () => {
    test("fetches children through the classic search endpoint", async () => {
      const requestedUrls: string[] = [];
      const mockFetch = async (input: RequestInfo | URL) => {
        const url = input.toString();
        requestedUrls.push(url);
        if (url.includes("/comment")) {
          return new Response(JSON.stringify({ comments: [] }));
        }
        return new Response(
          JSON.stringify({
            startAt: 0,
            total: 1,
            issues: [
              {
                id: "2",
                key: "TEST-2",
                fields: {
                  summary: "Child Issue",
                  status: { name: "Open" },
                  created: "2024-01-01T00:00:00.000Z",
                  updated: "2024-01-01T00:00:00.000Z",
                },
              },
            ],
          }),
        );
      };
      mockFetch.preconnect = async () => {};
      global.fetch = mockFetch;

      const result = await service.getEpicChildren("TEST-1");

      expect(result).toHaveLength(1);
      expect(result[0].key).toBe("TEST-2");
      expect(
        requestedUrls.some((u) =>
          u.includes("/rest/api/2/search?"),
        ),
      ).toBe(true);
      expect(requestedUrls.some((u) => u.includes("/search/jql"))).toBe(false);
    });
  });

  describe("getIssueWithComments", () => {
    test("uses the v2 issue endpoint", async () => {
      const requestedUrls: string[] = [];
      const mockFetch = async (input: RequestInfo | URL) => {
        const url = input.toString();
        requestedUrls.push(url);
        if (url.includes("/comment")) {
          return new Response(JSON.stringify({ comments: [] }));
        }
        return new Response(
          JSON.stringify({
            id: "1",
            key: "TEST-1",
            fields: {
              summary: "Server Issue",
              status: { name: "Open" },
              created: "2024-01-01T00:00:00.000Z",
              updated: "2024-01-01T00:00:00.000Z",
            },
          }),
        );
      };
      mockFetch.preconnect = async () => {};
      global.fetch = mockFetch;

      const result = await service.getIssueWithComments("TEST-1");

      expect(result.key).toBe("TEST-1");
      expect(requestedUrls.every((u) => u.includes("/rest/api/2/"))).toBe(true);
      expect(requestedUrls.some((u) => u.includes("/rest/api/3/"))).toBe(false);
    });
  });
});
