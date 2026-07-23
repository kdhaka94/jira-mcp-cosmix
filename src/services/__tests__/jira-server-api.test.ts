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
      const searchUrl = requestedUrls.find((u) =>
        u.includes("/rest/api/2/search?"),
      );
      expect(searchUrl).toBeDefined();
      // Server/DC keeps the classic Epic Link clause, not the Cloud parent field.
      expect(new URL(searchUrl!).searchParams.get("jql")).toBe(
        '"Epic Link" = TEST-1',
      );
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

    test("extracts plain-string descriptions and comment bodies (v2)", async () => {
      const mockFetch = async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/comment")) {
          return new Response(
            JSON.stringify({
              comments: [
                {
                  id: "9",
                  body: "A plain server comment",
                  author: { displayName: "Server User" },
                  created: "2024-01-01T00:00:00.000Z",
                  updated: "2024-01-01T00:00:00.000Z",
                },
              ],
            }),
          );
        }
        return new Response(
          JSON.stringify({
            id: "1",
            key: "TEST-1",
            fields: {
              summary: "Server Issue",
              description: "A plain server description",
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

      // v2 returns bodies as plain strings, not ADF objects.
      expect(result.description).toBe("A plain server description");
      expect(result.comments?.[0].body).toBe("A plain server comment");
    });
  });

  describe("addCommentToIssue", () => {
    test("sends a plain string body and reads a string body back (v2)", async () => {
      let sentPayload: any;
      let requestedUrl = "";
      const mockFetch = async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        requestedUrl = input.toString();
        sentPayload = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            id: "42",
            author: { displayName: "Server User" },
            body: "Hello from server",
            created: "2024-01-02T00:00:00.000Z",
            updated: "2024-01-02T00:00:00.000Z",
          }),
          { status: 201 },
        );
      };
      mockFetch.preconnect = async () => {};
      global.fetch = mockFetch;

      const result = await service.addCommentToIssue(
        "TEST-1",
        "Hello from server",
      );

      expect(requestedUrl).toContain("/rest/api/2/issue/TEST-1/comment");
      // Body sent to Server/DC must be a plain string, not an ADF object.
      expect(typeof sentPayload.body).toBe("string");
      expect(sentPayload.body).toBe("Hello from server");
      expect(result.body).toBe("Hello from server");
      expect(result.author).toBe("Server User");
    });
  });

  describe("createIssue", () => {
    test("sends the description as a plain string (v2)", async () => {
      let sentPayload: any;
      let requestedUrl = "";
      const mockFetch = async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        requestedUrl = input.toString();
        sentPayload = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ id: "1", key: "TEST-1" }), {
          status: 201,
        });
      };
      mockFetch.preconnect = async () => {};
      global.fetch = mockFetch;

      await service.createIssue("TEST", "Task", "Summary", "Plain description");

      expect(requestedUrl).toContain("/rest/api/2/issue");
      expect(sentPayload.fields.description).toBe("Plain description");
    });
  });

  describe("transitionIssue", () => {
    test("sends the transition comment as a plain string (v2)", async () => {
      let sentPayload: any;
      let requestedUrl = "";
      const mockFetch = async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        requestedUrl = input.toString();
        sentPayload = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({}), { status: 200 });
      };
      mockFetch.preconnect = async () => {};
      global.fetch = mockFetch;

      await service.transitionIssue("TEST-1", "31", "Moving to done");

      expect(requestedUrl).toContain("/rest/api/2/issue/TEST-1/transitions");
      expect(sentPayload.transition).toEqual({ id: "31" });
      // Transition comment body must be a plain string on v2, not ADF.
      expect(sentPayload.update.comment[0].add.body).toBe("Moving to done");
    });
  });
});
