import { describe, expect, it, beforeEach } from "vitest";
import {
  classifyLinkTarget,
  isExternalLink,
} from "@/core/references/classifyLinkTarget";
import { useTreeStore } from "@/core/stores/useTreeStore";

describe("classifyLinkTarget", () => {
  // Reset tree store before each test to ensure clean state
  beforeEach(() => {
    useTreeStore.setState({ documents: [], folders: [] });
  });

  describe("external URLs", () => {
    it("classifies https URLs as external", () => {
      const result = classifyLinkTarget("https://google.com");
      expect(result.type).toBe("external");
      expect(result.normalizedPath).toBe("https://google.com");
    });

    it("classifies http URLs as external", () => {
      const result = classifyLinkTarget("http://example.com");
      expect(result.type).toBe("external");
    });

    it("classifies mailto links as external", () => {
      const result = classifyLinkTarget("mailto:user@example.com");
      expect(result.type).toBe("external");
      expect(result.normalizedPath).toBe("mailto:user@example.com");
    });

    it("classifies tel links as external", () => {
      const result = classifyLinkTarget("tel:+1234567890");
      expect(result.type).toBe("external");
    });

    it("classifies ftp URLs as external", () => {
      const result = classifyLinkTarget("ftp://files.example.com");
      expect(result.type).toBe("external");
    });

    it("classifies file URLs as external", () => {
      const result = classifyLinkTarget("file:///path/to/file");
      expect(result.type).toBe("external");
    });

    it("is case-insensitive for protocols", () => {
      expect(classifyLinkTarget("HTTPS://GOOGLE.COM").type).toBe("external");
      expect(classifyLinkTarget("Mailto:USER@EXAMPLE.COM").type).toBe(
        "external",
      );
    });
  });

  describe("anchors", () => {
    it("classifies fragment-only links as anchor", () => {
      const result = classifyLinkTarget("#heading");
      expect(result.type).toBe("anchor");
      expect(result.normalizedPath).toBe("");
      if (result.type === "anchor") {
        expect(result.anchor).toBe("#heading");
      }
    });

    it("classifies single # as anchor", () => {
      const result = classifyLinkTarget("#");
      expect(result.type).toBe("anchor");
      if (result.type === "anchor") {
        expect(result.anchor).toBe("#");
      }
    });

    it("classifies complex fragment as anchor", () => {
      const result = classifyLinkTarget("#section-1-2");
      expect(result.type).toBe("anchor");
      if (result.type === "anchor") {
        expect(result.anchor).toBe("#section-1-2");
      }
    });
  });

  describe("unresolved paths (treated as external)", () => {
    // When tree store is empty, relative paths don't resolve → treated as external URLs

    it("classifies unresolved filename as external", () => {
      const result = classifyLinkTarget("path.md");
      expect(result.type).toBe("external");
      expect(result.normalizedPath).toBe("path.md");
    });

    it("classifies unresolved ./ path as external", () => {
      const result = classifyLinkTarget("./path.md");
      expect(result.type).toBe("external");
      expect(result.normalizedPath).toBe("./path.md");
    });

    it("classifies unresolved ../ path as external", () => {
      const result = classifyLinkTarget("../folder/path.md");
      expect(result.type).toBe("external");
      expect(result.normalizedPath).toBe("../folder/path.md");
    });

    it("classifies bare domain as external", () => {
      // This is the key bug fix: google.com should be external, not internal
      const result = classifyLinkTarget("google.com");
      expect(result.type).toBe("external");
      expect(result.normalizedPath).toBe("google.com");
    });

    it("classifies unresolved path with anchor as external", () => {
      const result = classifyLinkTarget("path.md#section");
      expect(result.type).toBe("external");
      expect(result.normalizedPath).toBe("path.md#section");
    });
  });

  describe("resolved paths (internal)", () => {
    // When documents exist in tree store, matching paths resolve → internal

    beforeEach(() => {
      useTreeStore.setState({
        documents: [
          {
            id: "doc-1",
            projectId: "project-1",
            name: "My Document",
            path: "my-document.md",
            filename: "my-document.md",
            extension: ".md",
            folderId: null,
            updatedAt: new Date(),
            fileType: "markdown",
          },
          {
            id: "doc-2",
            projectId: "project-1",
            name: "Nested Doc",
            path: "folder/nested-doc.md",
            filename: "nested-doc.md",
            extension: ".md",
            folderId: "folder-1",
            updatedAt: new Date(),
            fileType: "markdown",
          },
        ],
        folders: [
          {
            id: "folder-1",
            projectId: "project-1",
            name: "folder",
            parentId: null,
            createdAt: new Date(),
          },
        ],
      });
    });

    it("classifies resolved document as internal with resolved ref", () => {
      const result = classifyLinkTarget("my-document.md");
      expect(result.type).toBe("internal");
      if (result.type === "internal") {
        expect(result.normalizedPath).toBe("my-document.md");
        expect(result.resolved.type).toBe("document");
        expect(result.resolved.id).toBe("doc-1");
      }
    });

    it("classifies resolved folder as internal", () => {
      const result = classifyLinkTarget("folder");
      expect(result.type).toBe("internal");
      if (result.type === "internal") {
        expect(result.resolved.type).toBe("folder");
        expect(result.resolved.id).toBe("folder-1");
      }
    });

    it("classifies resolved path with anchor as internal", () => {
      const result = classifyLinkTarget("my-document.md#section");
      expect(result.type).toBe("internal");
      if (result.type === "internal") {
        expect(result.normalizedPath).toBe("my-document.md");
        expect(result.anchor).toBe("#section");
        expect(result.resolved.id).toBe("doc-1");
      }
    });

    it("classifies resolved nested path as internal", () => {
      const result = classifyLinkTarget("folder/nested-doc.md");
      expect(result.type).toBe("internal");
      if (result.type === "internal") {
        expect(result.resolved.id).toBe("doc-2");
      }
    });

    it("still treats unresolved paths as external even with populated store", () => {
      const result = classifyLinkTarget("nonexistent.md");
      expect(result.type).toBe("external");
    });
  });

  describe("unsupported patterns", () => {
    it("classifies absolute Unix paths as unsupported", () => {
      const result = classifyLinkTarget("/absolute/path.md");
      expect(result.type).toBe("unsupported");
      expect(result.normalizedPath).toBe("/absolute/path.md");
    });

    it("classifies Windows paths as unsupported", () => {
      expect(classifyLinkTarget("C:\\path\\file.md").type).toBe("unsupported");
      expect(classifyLinkTarget("D:/path/file.md").type).toBe("unsupported");
    });

    it("classifies paths with query strings as unsupported", () => {
      const result = classifyLinkTarget("path.md?query=value");
      expect(result.type).toBe("unsupported");
      expect(result.normalizedPath).toBe("path.md?query=value");
    });

    it("classifies empty string as unsupported", () => {
      const result = classifyLinkTarget("");
      expect(result.type).toBe("unsupported");
      expect(result.normalizedPath).toBe("");
    });

    it("classifies whitespace-only as unsupported", () => {
      const result = classifyLinkTarget("   ");
      expect(result.type).toBe("unsupported");
      expect(result.normalizedPath).toBe("");
    });
  });

  describe("whitespace handling", () => {
    it("trims leading and trailing whitespace", () => {
      // Unresolved path becomes external
      const result = classifyLinkTarget("  path.md  ");
      expect(result.type).toBe("external");
      expect(result.normalizedPath).toBe("path.md");
    });

    it("trims whitespace from URLs", () => {
      const result = classifyLinkTarget("  https://google.com  ");
      expect(result.type).toBe("external");
      expect(result.normalizedPath).toBe("https://google.com");
    });
  });
});

describe("isExternalLink", () => {
  it("returns true for external URLs", () => {
    expect(isExternalLink("https://google.com")).toBe(true);
    expect(isExternalLink("http://example.com")).toBe(true);
    expect(isExternalLink("mailto:user@example.com")).toBe(true);
  });

  it("returns false for internal paths", () => {
    expect(isExternalLink("path.md")).toBe(false);
    expect(isExternalLink("./path.md")).toBe(false);
    expect(isExternalLink("../folder/path.md")).toBe(false);
  });

  it("returns false for anchors", () => {
    expect(isExternalLink("#heading")).toBe(false);
  });

  it("handles whitespace", () => {
    expect(isExternalLink("  https://google.com  ")).toBe(true);
    expect(isExternalLink("  path.md  ")).toBe(false);
  });
});
