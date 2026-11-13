/*
 * The map's data model, with no DOM or React: validation, the level index, the trail from a
 * root to a level, and source links. check.mjs runs the same `validate` in Node, so the page
 * and the check can't disagree about what a well-formed map is.
 */
(() => {
  const ArchMap = globalThis.ArchMap ?? {};
  globalThis.ArchMap = ArchMap;

  /** What a box's kind is called on screen. */
  const KIND_LABELS = {
    person: "Person",
    client: "Client",
    service: "Service",
    sandbox: "Sandbox",
    store: "Store",
    external: "External",
    files: "Files",
    domain: "Server domain",
    feature: "App feature",
    module: "Module",
    package: "Package",
    context: "Elsewhere",
  };

  /** What each arrow kind carries, for the legend. */
  const EDGE_KINDS = {
    http: "HTTP request",
    sse: "Server-sent events",
    ws: "WebSocket",
    model: "Model or tool provider call",
    files: "Files (R2, mounts, disk)",
    sql: "SQL",
    call: "Function call",
    port: "Through a port",
    import: "Import",
  };

  /** Hash ids: ASCII letters, digits and hyphens, so a link opens straight into a level. */
  const LEVEL_ID = /^[a-z0-9-]+$/;
  const NODE_ID = /^[A-Za-z0-9]+$/;

  const isText = (value) => typeof value === "string" && value.trim() !== "";
  const isTextList = (value) =>
    value === undefined || (Array.isArray(value) && value.every(isText));

  /** Every problem with the map, as sentences; empty when it is well formed. */
  function validate(data) {
    const errors = [];
    if (!data || !Array.isArray(data.levels)) return ["The map has no levels array."];
    const levelIds = new Set();
    for (const level of data.levels) {
      if (!LEVEL_ID.test(level.id ?? ""))
        errors.push(`Level id "${level.id}" must be lowercase letters, digits and hyphens.`);
      if (levelIds.has(level.id)) errors.push(`Level "${level.id}" appears twice.`);
      levelIds.add(level.id);
    }
    if (!Array.isArray(data.roots) || data.roots.length === 0)
      errors.push("The map needs at least one root.");
    for (const root of data.roots ?? []) {
      if (!levelIds.has(root.id)) errors.push(`Root "${root.id}" is not a level.`);
      if (!isText(root.label)) errors.push(`Root "${root.id}" needs a label.`);
    }
    for (const level of data.levels) {
      const where = `Level "${level.id}"`;
      if (!isText(level.title) || !isText(level.summary))
        errors.push(`${where} needs a title and a summary.`);
      if (level.parent !== null && !levelIds.has(level.parent))
        errors.push(`${where} has unknown parent "${level.parent}".`);
      if (!isTextList(level.rules) || !isTextList(level.docs))
        errors.push(`${where}: rules and docs must be lists of text.`);
      if (!Array.isArray(level.nodes) || !Array.isArray(level.edges))
        errors.push(`${where} needs nodes and edges lists (edges may be empty).`);
      const nodeIds = new Set();
      for (const node of level.nodes ?? []) {
        const at = `${where}, box "${node.id}"`;
        if (!NODE_ID.test(node.id ?? "")) errors.push(`${at}: id must be letters and digits.`);
        if (nodeIds.has(node.id)) errors.push(`${at} appears twice.`);
        nodeIds.add(node.id);
        if (!Object.hasOwn(KIND_LABELS, node.kind ?? ""))
          errors.push(`${at}: unknown kind "${node.kind}".`);
        if (!isText(node.label) || !isText(node.sub) || !isText(node.about))
          errors.push(`${at} needs a label, a sub and an about.`);
        for (const field of ["paths", "docs", "machines", "rules", "breaks", "drift"]) {
          if (!isTextList(node[field])) errors.push(`${at}: ${field} must be a list of text.`);
        }
        if (node.child !== undefined && !levelIds.has(node.child))
          errors.push(`${at} opens unknown level "${node.child}".`);
        if (node.child === level.id) errors.push(`${at} opens its own level.`);
        if (node.shot !== undefined && !parseShot(node.shot))
          errors.push(
            `${at}: shot must be "<shot>" or "<shot>/<region>", in lowercase and hyphens.`,
          );
      }
      for (const edge of level.edges ?? []) {
        const at = `${where}, arrow ${edge.from} to ${edge.to}`;
        if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to))
          errors.push(`${at} names a box the level doesn't have.`);
        if (!Object.hasOwn(EDGE_KINDS, edge.kind ?? ""))
          errors.push(`${at}: unknown kind "${edge.kind}".`);
        if (typeof edge.label !== "string") errors.push(`${at} needs a label (it may be empty).`);
        for (const flag of ["both", "breaks"]) {
          if (edge[flag] !== undefined && typeof edge[flag] !== "boolean")
            errors.push(`${at}: ${flag} must be true or false.`);
        }
      }
    }
    // A parent chain that loops would make the breadcrumb endless.
    const parentOf = new Map(data.levels.map((level) => [level.id, level.parent]));
    for (const level of data.levels) {
      const seen = new Set();
      for (let id = level.id; id !== null && id !== undefined; id = parentOf.get(id)) {
        if (seen.has(id)) {
          errors.push(`Level "${level.id}" has a parent chain that loops.`);
          break;
        }
        seen.add(id);
      }
    }
    return errors;
  }

  /** A box's screen: "<shot>" for the whole screenshot, "<shot>/<arch>" for one region of it. */
  const SHOT_REF = /^([a-z0-9-]+)(?:\/([a-z0-9-]+))?$/;
  function parseShot(ref) {
    const match = typeof ref === "string" ? SHOT_REF.exec(ref) : null;
    return match ? { name: match[1], arch: match[2] ?? null } : null;
  }

  /**
   * What `ref` names in the generated screens (`docs/screens/screens.js`): the shot and, when
   * the ref names one, its region. `error` says what is missing.
   */
  function resolveShot(screens, ref) {
    const parsed = parseShot(ref);
    if (!parsed) return { error: `"${ref}" is not a shot name` };
    const shot = screens?.[parsed.name];
    if (!shot) return { error: `no shot "${parsed.name}" in docs/screens/screens.js` };
    if (!parsed.arch) return { name: parsed.name, shot, region: null };
    const region = shot.regions.find((r) => r.arch === parsed.arch);
    if (!region) return { error: `shot "${parsed.name}" has no region "${parsed.arch}"` };
    return { name: parsed.name, shot, region };
  }

  /**
   * The hash is a level, optionally with a box on it selected, or an arrow highlighted:
   * `#api`, `#api/routes`, `#api/routes-store` (arrow from box to box; ids are alphanumeric, so
   * the hyphen is unambiguous). Anything after the level that is neither names nothing.
   */
  function parseHash(hash) {
    const [level, target, ...extra] = hash.split("/");
    const arrow = /^([A-Za-z0-9]+)-([A-Za-z0-9]+)$/.exec(target ?? "");
    return {
      level,
      box: !extra.length && NODE_ID.test(target ?? "") ? target : null,
      arrow: !extra.length && arrow ? { from: arrow[1], to: arrow[2] } : null,
    };
  }

  /** The hash that opens `level` with a box selected, or an arrow highlighted. */
  const hashOf = (level, { box, arrow } = {}) =>
    `#${level}${box ? `/${box}` : arrow ? `/${arrow.from}-${arrow.to}` : ""}`;

  /**
   * Why a map reference, "<level>/<box>" or "<level>/<from>-<to>", points at nothing; null when it
   * points at a box or an arrow the map has.
   */
  function mapRefProblem(data, ref) {
    const { level: levelId, box, arrow } = parseHash(ref);
    const level = data.levels.find((l) => l.id === levelId);
    if (!level) return `level "${levelId}" doesn't exist`;
    if (box)
      return level.nodes.some((n) => n.id === box)
        ? null
        : `level "${levelId}" has no box "${box}"`;
    if (arrow)
      return level.edges.some((e) => e.from === arrow.from && e.to === arrow.to)
        ? null
        : `level "${levelId}" has no arrow ${arrow.from} -> ${arrow.to}`;
    return `"${ref}" is neither "<level>/<box>" nor "<level>/<from>-<to>"`;
  }

  /** Levels by id. */
  const indexLevels = (data) => new Map(data.levels.map((level) => [level.id, level]));

  /** The levels from the root down to `levelId`, inclusive. */
  function trail(levels, levelId) {
    const out = [];
    for (let level = levels.get(levelId); level; level = levels.get(level.parent))
      out.unshift(level);
    return out;
  }

  /** Every repo path a box or level names, for the existence check. URLs are not paths. */
  function repoPaths(data) {
    const out = [];
    for (const level of data.levels) {
      for (const path of level.docs ?? []) out.push({ path, where: `level "${level.id}"` });
      for (const node of level.nodes ?? []) {
        for (const path of [...(node.paths ?? []), ...(node.docs ?? []), ...(node.machines ?? [])]) {
          out.push({ path, where: `level "${level.id}", box "${node.id}"` });
        }
      }
    }
    return out.filter(({ path }) => !isUrl(path));
  }

  const isUrl = (path) => /^https?:\/\//.test(path);

  /** A repo path as a link to it on GitHub; a URL stays as it is. */
  const sourceUrl = (data, path) =>
    isUrl(path) ? path : `https://github.com/${data.repo}/blob/${data.branch}/${path}`;

  ArchMap.model = {
    KIND_LABELS,
    EDGE_KINDS,
    validate,
    indexLevels,
    trail,
    repoPaths,
    sourceUrl,
    isUrl,
    parseShot,
    resolveShot,
    parseHash,
    hashOf,
    mapRefProblem,
  };
})();
