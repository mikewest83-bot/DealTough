export type LandscapingProjectType =
  | "mulch"
  | "pine_straw"
  | "sod"
  | "pavers"
  | "planting"
  | "cleanup"
  | "irrigation"
  | "lawn_service";

export interface LandscapingEstimateInput {
  projectType: LandscapingProjectType | string;
  areaSqFt?: number;
  lengthFt?: number;
  widthFt?: number;
  depthIn?: number;
  wastePercent?: number;
  coverageSqFtPerBale?: number;
  plantCount?: number;
  plantSize?: "small" | "medium" | "large" | string;
  crewHours?: number;
  disposalLoads?: number;
  zones?: number;
  visits?: number;
}

export interface EstimateLine {
  label: string;
  qty: number;
  unit: string;
  unitLow: number;
  unitHigh: number;
  low: number;
  high: number;
  note?: string;
}

export interface LandscapingEstimate {
  calculation: "landscaping_estimate";
  projectType: LandscapingProjectType;
  region: string;
  pricingBasis: string;
  areaSqFt?: number;
  quantity: Record<string, number | string>;
  materialTakeoff: EstimateLine[];
  diyMaterialsTotal: { low: number; high: number };
  installedRange: {
    low: number;
    high: number;
    unit: string;
    unitLow?: number;
    unitHigh?: number;
    perVisitLow?: number;
    perVisitHigh?: number;
  };
  notIncluded: string[];
  assumptions: string[];
  note: string;
}

const PROJECT_TYPES: LandscapingProjectType[] = [
  "mulch",
  "pine_straw",
  "sod",
  "pavers",
  "planting",
  "cleanup",
  "irrigation",
  "lawn_service",
];

const ALIASES: Record<string, LandscapingProjectType> = {
  mulch: "mulch",
  pine_straw: "pine_straw",
  pinestraw: "pine_straw",
  sod: "sod",
  sod_installation: "sod",
  paver: "pavers",
  pavers: "pavers",
  paver_patio: "pavers",
  planting: "planting",
  plants: "planting",
  cleanup: "cleanup",
  yard_cleanup: "cleanup",
  clean_up: "cleanup",
  irrigation: "irrigation",
  sprinkler: "irrigation",
  sprinklers: "irrigation",
  lawn_service: "lawn_service",
  mowing: "lawn_service",
  lawn: "lawn_service",
};

const REGION = "Southeast US 2026 (Charleston-class)";

function round(value: number, places = 2): number {
  return Number(value.toFixed(places));
}

function optionalNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function line(
  label: string,
  qty: number,
  unit: string,
  unitLow: number,
  unitHigh: number,
  note?: string,
): EstimateLine {
  return {
    label,
    qty: round(qty, 3),
    unit,
    unitLow,
    unitHigh,
    low: round(qty * unitLow),
    high: round(qty * unitHigh),
    ...(note ? { note } : {}),
  };
}

function total(rows: EstimateLine[]): { low: number; high: number } {
  return {
    low: round(rows.reduce((sum, row) => sum + row.low, 0)),
    high: round(rows.reduce((sum, row) => sum + row.high, 0)),
  };
}

export function estimateLandscaping(input: LandscapingEstimateInput): LandscapingEstimate {
  if (!input || typeof input !== "object") throw new Error("A landscaping estimate request is required");

  const rawType = String(input.projectType ?? "").toLowerCase().trim();
  const projectType = ALIASES[rawType];
  if (!projectType) {
    throw new Error(`projectType must be one of: ${PROJECT_TYPES.join(", ")}`);
  }

  const suppliedArea = optionalNumber(input.areaSqFt);
  const length = optionalNumber(input.lengthFt);
  const width = optionalNumber(input.widthFt);
  const area = suppliedArea ?? (length !== null && width !== null ? length * width : null);

  const requireArea = (): number => {
    if (area === null || area <= 0) {
      throw new Error("A positive areaSqFt, or positive lengthFt and widthFt, is required");
    }
    return area;
  };

  const finish = ({
    quantity,
    materials = [],
    installedRange,
    notIncluded = [],
    assumptions = [],
  }: {
    quantity: Record<string, number | string>;
    materials?: EstimateLine[];
    installedRange: LandscapingEstimate["installedRange"];
    notIncluded?: string[];
    assumptions?: string[];
  }): LandscapingEstimate => ({
    calculation: "landscaping_estimate",
    projectType,
    region: REGION,
    pricingBasis: "2026 Southeast low-high planning range",
    ...(area !== null && area > 0 ? { areaSqFt: round(area) } : {}),
    quantity,
    materialTakeoff: materials,
    diyMaterialsTotal: total(materials),
    installedRange,
    notIncluded,
    assumptions,
    note:
      REGION +
      " planning estimate, not a binding bid. Confirm measurements, access, site condition, material grade, delivery, tax, and disposal before quoting a customer.",
  });

  if (projectType === "mulch") {
    const projectArea = requireArea();
    const depth = optionalNumber(input.depthIn) ?? 3;
    const waste = optionalNumber(input.wastePercent) ?? 10;
    if (depth <= 0 || waste < 0) throw new Error("depthIn must be positive and wastePercent cannot be negative");
    const rawYards = (projectArea * (depth / 12)) / 27;
    const yards = Math.ceil(rawYards * (1 + waste / 100) * 2) / 2;
    const materials = [
      line("Bulk mulch", yards, "yd³", 35, 65, "Natural hardwood baseline; dyed or premium mulch costs more."),
    ];
    const installed = line("Delivered and installed mulch", yards, "yd³", 85, 150);
    return finish({
      quantity: { cubicYardsToOrder: yards, depthIn: depth, wastePercent: waste },
      materials,
      installedRange: { low: installed.low, high: installed.high, unit: "yd³", unitLow: 85, unitHigh: 150 },
      notIncluded: ["bed edging", "weed removal", "landscape fabric", "major grading"],
      assumptions: ["Open access for wheelbarrow work", "Existing beds are ready for mulch"],
    });
  }

  if (projectType === "pine_straw") {
    const projectArea = requireArea();
    const coverage = optionalNumber(input.coverageSqFtPerBale) ?? 45;
    const waste = optionalNumber(input.wastePercent) ?? 5;
    if (coverage <= 0 || waste < 0) {
      throw new Error("coverageSqFtPerBale must be positive and wastePercent cannot be negative");
    }
    const bales = Math.ceil((projectArea / coverage) * (1 + waste / 100));
    const materials = [line("Longleaf pine straw", bales, "bale", 6, 10)];
    const installed = line("Delivered and installed pine straw", bales, "bale", 12, 18);
    return finish({
      quantity: { balesToOrder: bales, coverageSqFtPerBale: coverage, wastePercent: waste },
      materials,
      installedRange: { low: installed.low, high: installed.high, unit: "bale", unitLow: 12, unitHigh: 18 },
      notIncluded: ["bed edging", "weed removal", "bed reshaping"],
      assumptions: ["Longleaf bales with normal bed access"],
    });
  }

  if (projectType === "sod") {
    const projectArea = requireArea();
    const waste = optionalNumber(input.wastePercent) ?? 5;
    if (waste < 0) throw new Error("wastePercent cannot be negative");
    const orderArea = Math.ceil(projectArea * (1 + waste / 100));
    const materials = [
      line("Warm-season sod", orderArea, "sq ft", 0.45, 0.85, "Centipede, Bermuda, or comparable common turf."),
    ];
    const installed = line("Sod delivered and installed", orderArea, "sq ft", 1.5, 3.25);
    return finish({
      quantity: { sodSqFtToOrder: orderArea, wastePercent: waste },
      materials,
      installedRange: { low: installed.low, high: installed.high, unit: "sq ft", unitLow: 1.5, unitHigh: 3.25 },
      notIncluded: ["irrigation repair", "major grading", "tree-root removal", "soil testing"],
      assumptions: ["Old turf is already removed or requires only light prep", "Water is available immediately after installation"],
    });
  }

  if (projectType === "pavers") {
    const projectArea = requireArea();
    const waste = optionalNumber(input.wastePercent) ?? 10;
    if (waste < 0) throw new Error("wastePercent cannot be negative");
    const orderArea = Math.ceil(projectArea * (1 + waste / 100));
    const materials = [
      line("Concrete pavers", orderArea, "sq ft", 3, 7),
      line("Compacted base, bedding sand, and edge restraint", orderArea, "sq ft", 1.5, 3),
    ];
    const installed = line("Excavate, base, and install pavers", projectArea, "sq ft", 12, 25);
    return finish({
      quantity: { paverSqFtToOrder: orderArea, finishedAreaSqFt: round(projectArea), wastePercent: waste },
      materials,
      installedRange: { low: installed.low, high: installed.high, unit: "sq ft", unitLow: 12, unitHigh: 25 },
      notIncluded: ["permit", "drainage redesign", "retaining walls", "utility relocation", "premium stone"],
      assumptions: ["Normal soil and machine access", "Simple pattern with limited cuts"],
    });
  }

  if (projectType === "planting") {
    const count = optionalNumber(input.plantCount);
    if (count === null || count <= 0) throw new Error("A positive plantCount is required");
    const size = String(input.plantSize ?? "medium").toLowerCase().trim();
    const ranges = {
      small: { material: [15, 35], installed: [40, 90], note: "1–3 gallon plant baseline" },
      medium: { material: [35, 85], installed: [90, 200], note: "5–7 gallon shrub baseline" },
      large: { material: [85, 250], installed: [200, 500], note: "Large shrub or small ornamental tree baseline" },
    } as const;
    if (!(size in ranges)) throw new Error("plantSize must be small, medium, or large");
    const selected = ranges[size as keyof typeof ranges];
    const materials = [
      line("Plants", count, "plant", selected.material[0], selected.material[1], selected.note),
    ];
    const installed = line(
      "Plants supplied and installed",
      count,
      "plant",
      selected.installed[0],
      selected.installed[1],
    );
    return finish({
      quantity: { plantCount: count, plantSize: size },
      materials,
      installedRange: {
        low: installed.low,
        high: installed.high,
        unit: "plant",
        unitLow: selected.installed[0],
        unitHigh: selected.installed[1],
      },
      notIncluded: ["irrigation", "bed construction", "tree staking", "warranty beyond establishment"],
      assumptions: ["Ordinary digging conditions", "Plant selection fits the site and season"],
    });
  }

  if (projectType === "cleanup") {
    const crewHours = optionalNumber(input.crewHours);
    if (crewHours === null || crewHours <= 0) {
      throw new Error("Positive crewHours are required (clock hours for the whole crew)");
    }
    const loads = optionalNumber(input.disposalLoads) ?? 1;
    if (loads < 0) throw new Error("disposalLoads cannot be negative");
    const rows = [
      line("Landscape cleanup crew", crewHours, "crew hr", 95, 165),
      ...(loads ? [line("Haul-off and disposal", loads, "load", 75, 250)] : []),
    ];
    const range = total(rows);
    return finish({
      quantity: { crewHours, disposalLoads: loads },
      materials: rows.filter((row) => row.label.includes("Haul-off")),
      installedRange: { low: range.low, high: range.high, unit: "project" },
      notIncluded: ["hazardous waste", "stump grinding", "large-tree removal", "dumpster permit"],
      assumptions: ["Two-person crew with normal access", "Green waste and ordinary yard debris"],
    });
  }

  if (projectType === "irrigation") {
    let zones = optionalNumber(input.zones);
    if ((zones === null || zones <= 0) && area !== null && area > 0) {
      zones = Math.max(1, Math.ceil(area / 2500));
    }
    if (zones === null || zones <= 0) {
      throw new Error("Positive zones, or enough area to estimate zones, are required");
    }
    const installed = line("New irrigation zone", zones, "zone", 800, 1400);
    return finish({
      quantity: { estimatedZones: zones },
      installedRange: { low: installed.low, high: installed.high, unit: "zone", unitLow: 800, unitHigh: 1400 },
      notIncluded: ["well or pump", "major boring", "backflow upgrade", "smart controller", "restoration outside trenches"],
      assumptions: ["Municipal water connection is available", "Typical residential spray/rotor layout"],
    });
  }

  const projectArea = requireArea();
  const visits = optionalNumber(input.visits) ?? 1;
  if (visits <= 0) throw new Error("visits must be positive");
  const perVisitLow = Math.max(45, projectArea * 0.005);
  const perVisitHigh = Math.max(75, projectArea * 0.012);
  return finish({
    quantity: { visits, lawnAreaSqFt: round(projectArea) },
    installedRange: {
      low: round(perVisitLow * visits),
      high: round(perVisitHigh * visits),
      unit: "project",
      perVisitLow: round(perVisitLow),
      perVisitHigh: round(perVisitHigh),
    },
    notIncluded: ["leaf removal", "bagging", "overgrown-lot surcharge", "hedge trimming"],
    assumptions: ["Routine mow, edge, trim, and blow", "Residential lawn with normal access"],
  });
}
