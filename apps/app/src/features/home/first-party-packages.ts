import { msg } from "@lingui/core/macro";
import { BookOpen, FlaskConical, LineChart, Microscope } from "lucide-react";

import type { PackageCardData } from "./package-card-data";

/**
 * Hardcoded first-party agent packages. Phase 1 only — no install flow, no
 * server catalog. When the package system ships, this list moves behind an API.
 */
export const FIRST_PARTY_PACKAGES: PackageCardData[] = [
  {
    id: "literature-review",
    name: msg`Literature Review`,
    description: msg`Search papers, extract findings, and synthesize a summary across sources.`,
    icon: BookOpen,
  },
  {
    id: "data-analysis",
    name: msg`Data Analysis`,
    description: msg`Plot, transform, and reason over tabular data with code-generating tools.`,
    icon: LineChart,
  },
  {
    id: "lab-notebook",
    name: msg`Lab Notebook`,
    description: msg`Capture experiments, methods, and observations in a structured log.`,
    icon: FlaskConical,
  },
  {
    id: "protocol-designer",
    name: msg`Protocol Designer`,
    description: msg`Draft and iterate on lab protocols with reagent + step suggestions.`,
    icon: Microscope,
  },
];
