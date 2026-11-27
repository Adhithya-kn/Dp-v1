export interface RoadRegistryEntry {
  global_name: string;
  bangalore_name: string;
  road_type: string;
  intersection_name: string;
  intersection_id: string;
  city_zone: string;
}

export interface CorridorGeoEntry {
  lanes: number;
  lane_breakdown: string[];
  speed_limit_kmh: number;
  coordinates: [number, number][];
  place_aliases: string[];
}

export interface CorridorGpsEntry {
  name: string;
  zone: string;
  lat: number;
  lon: number;
  free_flow: number;
}

export const ROAD_REGISTRY: Record<string, RoadRegistryEntry> = {
  RD_BLR_01: {
    global_name: "100 Feet Road",
    bangalore_name: "100 Feet Road",
    road_type: "Primary Commercial Arterial",
    intersection_name: "CMH Road Junction",
    intersection_id: "INT_BLR_05",
    city_zone: "Indiranagar",
  },
  RD_BLR_02: {
    global_name: "Anil Kumble Circle",
    bangalore_name: "Anil Kumble Circle",
    road_type: "CBD Commercial Intersection",
    intersection_name: "Anil Kumble Crossing",
    intersection_id: "INT_BLR_03",
    city_zone: "M.G. Road CBD",
  },
  RD_BLR_03: {
    global_name: "Ballari Road",
    bangalore_name: "Ballari Road",
    road_type: "Airport Express Highway (NH-44)",
    intersection_name: "Bellary Airport Toll Crossing",
    intersection_id: "INT_BLR_04",
    city_zone: "Hebbal North",
  },
  RD_BLR_04: {
    global_name: "CMH Road",
    bangalore_name: "CMH Road",
    road_type: "Metro Transit Arterial",
    intersection_name: "100 Feet Road Junction",
    intersection_id: "INT_BLR_01",
    city_zone: "Indiranagar",
  },
  RD_BLR_05: {
    global_name: "Hebbal Flyover",
    bangalore_name: "Hebbal Flyover",
    road_type: "Multi-lane Cloverleaf Interchange",
    intersection_name: "Hebbal Flyover Cloverleaf",
    intersection_id: "INT_BLR_06",
    city_zone: "Hebbal North",
  },
  RD_BLR_06: {
    global_name: "Hosur Road",
    bangalore_name: "Hosur Road",
    road_type: "Elevated Expressway Arterial",
    intersection_name: "Hosur Road Expressway Gate",
    intersection_id: "INT_BLR_08",
    city_zone: "Electronic City South",
  },
  RD_BLR_07: {
    global_name: "ITPL Main Road",
    bangalore_name: "ITPL Main Road",
    road_type: "Technology Park Corridor",
    intersection_name: "Hope Farm Crossing",
    intersection_id: "INT_BLR_07",
    city_zone: "Whitefield",
  },
  RD_BLR_08: {
    global_name: "Jayanagar 4th Block",
    bangalore_name: "Jayanagar 4th Block",
    road_type: "Commercial & Cultural Spine",
    intersection_name: "4th Block Complex Gate",
    intersection_id: "INT_BLR_02",
    city_zone: "Jayanagar",
  },
  RD_BLR_09: {
    global_name: "Marathahalli Bridge",
    bangalore_name: "Marathahalli Bridge",
    road_type: "Multi-lane Bridge Interchange",
    intersection_name: "Marathahalli Bridge Interchange",
    intersection_id: "INT_BLR_09",
    city_zone: "Whitefield",
  },
  RD_BLR_10: {
    global_name: "Sarjapur Road",
    bangalore_name: "Sarjapur Road",
    road_type: "High-Density Arterial Corridor",
    intersection_name: "Sarjapur-Koramangala Link",
    intersection_id: "INT_BLR_10",
    city_zone: "Koramangala",
  },
  RD_BLR_11: {
    global_name: "Silk Board Junction",
    bangalore_name: "Silk Board Junction",
    road_type: "High-Capacity Flyover Interchange",
    intersection_name: "Silk Board Interchange Flyover",
    intersection_id: "INT_BLR_11",
    city_zone: "Electronic City South",
  },
  RD_BLR_12: {
    global_name: "Sony World Junction",
    bangalore_name: "Sony World Junction",
    road_type: "Major 4-Way Retail Intersection",
    intersection_name: "Sony World 4-Way Crossing",
    intersection_id: "INT_BLR_12",
    city_zone: "Koramangala",
  },
  RD_BLR_13: {
    global_name: "South End Circle",
    bangalore_name: "South End Circle",
    road_type: "Major 5-Way Rotary Intersection",
    intersection_name: "South End 5-Way Rotary",
    intersection_id: "INT_BLR_13",
    city_zone: "Jayanagar",
  },
  RD_BLR_14: {
    global_name: "Trinity Circle",
    bangalore_name: "Trinity Circle",
    road_type: "Metro CBD Rotary Interchange",
    intersection_name: "Trinity Circle Rotary",
    intersection_id: "INT_BLR_14",
    city_zone: "M.G. Road CBD",
  },
  RD_BLR_15: {
    global_name: "Tumkur Road",
    bangalore_name: "Tumkur Road",
    road_type: "National Highway Freight Corridor",
    intersection_name: "Tumkur Highway Crossing",
    intersection_id: "INT_BLR_15",
    city_zone: "Yeshwanthpur West",
  },
  RD_BLR_16: {
    global_name: "Yeshwanthpur Circle",
    bangalore_name: "Yeshwanthpur Circle",
    road_type: "Multi-Modal Transit Junction",
    intersection_name: "Yeshwanthpur Circle Rotary",
    intersection_id: "INT_BLR_16",
    city_zone: "Yeshwanthpur West",
  },
  RD_BLR_17: {
    global_name: "Old Airport Road",
    bangalore_name: "Old Airport Road",
    road_type: "Primary Arterial Corridor",
    intersection_name: "Domlur Flyover Junction",
    intersection_id: "INT_BLR_17",
    city_zone: "Indiranagar",
  },
  RD_BLR_18: {
    global_name: "Brigade Road",
    bangalore_name: "Brigade Road",
    road_type: "Commercial Pedestrian & Arterial Spine",
    intersection_name: "Residency Road Junction",
    intersection_id: "INT_BLR_18",
    city_zone: "M.G. Road CBD",
  },
  RD_BLR_19: {
    global_name: "Thanisandra Main Road",
    bangalore_name: "Thanisandra Main Road",
    road_type: "North Growth Corridor",
    intersection_name: "Nagavara Junction Crossing",
    intersection_id: "INT_BLR_19",
    city_zone: "Hebbal North",
  },
  RD_BLR_20: {
    global_name: "Electronic City Phase 1",
    bangalore_name: "Electronic City Phase 1",
    road_type: "Tech Hub Arterial Spine",
    intersection_name: "Toll Plaza Interchange",
    intersection_id: "INT_BLR_20",
    city_zone: "Electronic City South",
  },
  RD_BLR_21: {
    global_name: "Varthur Road",
    bangalore_name: "Varthur Road",
    road_type: "East Perimeter Transit Link",
    intersection_name: "Kundalahalli Gate Crossing",
    intersection_id: "INT_BLR_21",
    city_zone: "Whitefield",
  },
  RD_BLR_22: {
    global_name: "Kanakapura Road",
    bangalore_name: "Kanakapura Road",
    road_type: "National Highway Transit Link",
    intersection_name: "Sarakki Signal Junction",
    intersection_id: "INT_BLR_22",
    city_zone: "Jayanagar",
  },
  RD_BLR_23: {
    global_name: "Koramangala 80 Feet Road",
    bangalore_name: "Koramangala 80 Feet Road",
    road_type: "Major Commercial Link",
    intersection_name: "National Games Village Crossing",
    intersection_id: "INT_BLR_23",
    city_zone: "Koramangala",
  },
  RD_BLR_24: {
    global_name: "Malleshwaram 8th Cross",
    bangalore_name: "Malleshwaram 8th Cross",
    road_type: "Historic Transit Arterial",
    intersection_name: "Margosa Road Junction",
    intersection_id: "INT_BLR_24",
    city_zone: "Yeshwanthpur West",
  },
};

export const CORRIDOR_GEO_REGISTRY: Record<string, CorridorGeoEntry> = {
  RD_BLR_01: {
    lanes: 4,
    lane_breakdown: ["Lane 1: Curbside / Commercial Access", "Lane 2: Express Through Arterial"],
    speed_limit_kmh: 50.0,
    coordinates: [[12.9720, 77.6400], [12.9784, 77.6408], [12.9850, 77.6415]],
    place_aliases: ["100 feet road", "indiranagar 100 ft", "cmh road junction", "hal 2nd stage", "12th main indiranagar", "indiranagar metro"],
  },
  RD_BLR_02: {
    lanes: 6,
    lane_breakdown: ["Lane 1: Transit / Bus Stop", "Lane 2: CBD Core Through", "Lane 3: Right Turn to Cubbon Park"],
    speed_limit_kmh: 45.0,
    coordinates: [[12.9730, 77.6040], [12.9756, 77.6066], [12.9770, 77.6090]],
    place_aliases: ["anil kumble circle", "mg road", "m.g. road", "chinnaswamy stadium", "cubbon road", "commercial street"],
  },
  RD_BLR_03: {
    lanes: 6,
    lane_breakdown: ["Lane 1: Service Road Merge", "Lane 2: Airport Express", "Lane 3: Fast Transit"],
    speed_limit_kmh: 80.0,
    coordinates: [[13.0200, 77.5920], [13.0358, 77.5970], [13.0500, 77.6020]],
    place_aliases: ["ballari road", "bellary road", "airport road", "kempegowda airport express", "nh-44 hebbal", "sahakara nagar"],
  },
  RD_BLR_04: {
    lanes: 4,
    lane_breakdown: ["Lane 1: Metro Station Access", "Lane 2: CMH Metro Express"],
    speed_limit_kmh: 45.0,
    coordinates: [[12.9780, 77.6360], [12.9790, 77.6420], [12.9800, 77.6480]],
    place_aliases: ["cmh road", "chinmaya mission hospital road", "indiranagar metro station", "cmh hospital", "swami vivekananda road"],
  },
  RD_BLR_05: {
    lanes: 6,
    lane_breakdown: ["Lane 1: Outer Ring Road Ramp", "Lane 2: Flyover Main Span", "Lane 3: High-Speed Elevated Spurt"],
    speed_limit_kmh: 65.0,
    coordinates: [[13.0320, 77.5950], [13.0380, 77.5985], [13.0440, 77.6010]],
    place_aliases: ["hebbal flyover", "hebbal interchange", "hebbal lake", "manyata junction", "outer ring road hebbal"],
  },
  RD_BLR_06: {
    lanes: 8,
    lane_breakdown: ["Lane 1: Toll Gate Merge", "Lane 2: Surface Corridor", "Lane 3: Elevated Expressway 1", "Lane 4: Elevated Expressway 2"],
    speed_limit_kmh: 80.0,
    coordinates: [[12.8350, 77.6550], [12.8452, 77.6602], [12.8600, 77.6650]],
    place_aliases: ["hosur road", "elevated expressway", "electronic city elevated", "electronic city expressway", "bommanahalli", "attibele highway", "e-city toll", "electronic city flyover"],
  },
  RD_BLR_07: {
    lanes: 4,
    lane_breakdown: ["Lane 1: Tech Park Shuttle Lane", "Lane 2: ITPL Main Through"],
    speed_limit_kmh: 50.0,
    coordinates: [[12.9800, 77.7200], [12.9850, 77.7280], [12.9900, 77.7360]],
    place_aliases: ["itpl main road", "itpl", "international tech park", "whitefield main road", "hope farm junction", "kadugodi metro"],
  },
  RD_BLR_08: {
    lanes: 4,
    lane_breakdown: ["Lane 1: Shopping Complex Parking Merge", "Lane 2: Jayanagar Commercial Spine"],
    speed_limit_kmh: 40.0,
    coordinates: [[12.9220, 77.5900], [12.9250, 77.5938], [12.9280, 77.5980]],
    place_aliases: ["jayanagar 4th block", "jayanagar complex", "4th block bus terminus", "jayanagar bda complex", "3rd block jayanagar"],
  },
  RD_BLR_09: {
    lanes: 6,
    lane_breakdown: ["Lane 1: Marathahalli Market Ramp", "Lane 2: Ring Road Overpass Through", "Lane 3: East Expressway"],
    speed_limit_kmh: 60.0,
    coordinates: [[12.9510, 77.6950], [12.9560, 77.7010], [12.9620, 77.7080]],
    place_aliases: ["marathahalli bridge", "marathahalli interchange", "outer ring road marathahalli", "innovative multiplex", "kalamandir junction"],
  },
  RD_BLR_10: {
    lanes: 4,
    lane_breakdown: ["Lane 1: Curbside Retail Deceleration", "Lane 2: Sarjapur Arterial Through"],
    speed_limit_kmh: 50.0,
    coordinates: [[12.9200, 77.6450], [12.9240, 77.6520], [12.9290, 77.6600]],
    place_aliases: ["sarjapur road", "sarjapur main road", "wipro sarjapur", "carmelaram", "bellandur sarjapur junction"],
  },
  RD_BLR_11: {
    lanes: 8,
    lane_breakdown: ["Lane 1: BTM Ramp", "Lane 2: Hosur Merge", "Lane 3: Elevated Flyover Spurt", "Lane 4: Bus Priority Slip"],
    speed_limit_kmh: 50.0,
    coordinates: [[12.9120, 77.6180], [12.9176, 77.6238], [12.9220, 77.6290]],
    place_aliases: ["silk board junction", "central silk board", "silk board flyover", "btm silk board", "silk board metro interchange"],
  },
  RD_BLR_12: {
    lanes: 4,
    lane_breakdown: ["Lane 1: Retail Curb Friction Lane", "Lane 2: 80 Feet Throughway"],
    speed_limit_kmh: 45.0,
    coordinates: [[12.9320, 77.6210], [12.9352, 77.6245], [12.9380, 77.6280]],
    place_aliases: ["sony world junction", "sony world crossing", "koramangala 4th block", "koramangala 5th block", "jyoti nivas college link"],
  },
  RD_BLR_13: {
    lanes: 6,
    lane_breakdown: ["Lane 1: Lalbagh West Entry", "Lane 2: Rotary Flow Lane 1", "Lane 3: Rotary Flow Lane 2"],
    speed_limit_kmh: 45.0,
    coordinates: [[12.9250, 77.5750], [12.9280, 77.5790], [12.9320, 77.5830]],
    place_aliases: ["south end circle", "south end rotary", "lalbagh west gate", "south end metro", "basavanagudi link"],
  },
  RD_BLR_14: {
    lanes: 6,
    lane_breakdown: ["Lane 1: Halasuru Entry Slip", "Lane 2: Trinity Metro Through", "Lane 3: MG Road CBD Flyway"],
    speed_limit_kmh: 50.0,
    coordinates: [[12.9690, 77.6150], [12.9725, 77.6200], [12.9760, 77.6250]],
    place_aliases: ["trinity circle", "trinity metro station", "taj mg road", "halasuru lake road", "victoria road"],
  },
  RD_BLR_15: {
    lanes: 6,
    lane_breakdown: ["Lane 1: Freight / Heavy Vehicle Lane", "Lane 2: Highway Express Through", "Lane 3: Express Overtaking"],
    speed_limit_kmh: 70.0,
    coordinates: [[13.0200, 77.5320], [13.0280, 77.5400], [13.0350, 77.5480]],
    place_aliases: ["tumkur road", "nh-48 freight expressway", "peenya industrial corridor", "goraguntepalya", "dasarahalli metro"],
  },
  RD_BLR_16: {
    lanes: 6,
    lane_breakdown: ["Lane 1: Railway Station Slip Lane", "Lane 2: Circle Circulatory Flow", "Lane 3: Malleshwaram Flyover"],
    speed_limit_kmh: 50.0,
    coordinates: [[13.0200, 77.5480], [13.0238, 77.5529], [13.0280, 77.5580]],
    place_aliases: ["yeshwanthpur circle", "yeshwanthpur railway station", "yeshwanthpur market", "iisc gate link", "orion mall road"],
  },
  RD_BLR_17: {
    lanes: 4,
    lane_breakdown: ["Lane 1: Domlur Flyover Slip", "Lane 2: Old Airport Arterial Through"],
    speed_limit_kmh: 50.0,
    coordinates: [[12.9550, 77.6420], [12.9600, 77.6480], [12.9660, 77.6540]],
    place_aliases: ["old airport road", "hal airport road", "domlur flyover", "command hospital", "manipal hospital road", "murugeshpalya"],
  },
  RD_BLR_18: {
    lanes: 4,
    lane_breakdown: ["Lane 1: Pedestrian Promenade Merge", "Lane 2: Commercial Spine Corridor"],
    speed_limit_kmh: 40.0,
    coordinates: [[12.9700, 77.6060], [12.9730, 77.6075], [12.9760, 77.6090]],
    place_aliases: ["brigade road", "residency road junction", "garuda mall", "richmond town", "opera house crossing", "mg road brigade link"],
  },
  RD_BLR_19: {
    lanes: 4,
    lane_breakdown: ["Lane 1: Residential Connector Lane", "Lane 2: North Express Through"],
    speed_limit_kmh: 60.0,
    coordinates: [[13.0450, 77.6250], [13.0550, 77.6320], [13.0650, 77.6390]],
    place_aliases: ["thanisandra main road", "bhartiya city", "manyata back gate", "nagavara link", "hegde nagar"],
  },
  RD_BLR_20: {
    lanes: 6,
    lane_breakdown: ["Lane 1: Campus Shuttle Drop-off", "Lane 2: Tech Spine Through", "Lane 3: Phase 1 Expressway Loop"],
    speed_limit_kmh: 60.0,
    coordinates: [[12.8340, 77.6710], [12.8399, 77.6770], [12.8460, 77.6830]],
    place_aliases: ["electronic city phase 1", "electronic city expressway", "electronic city", "e-city expressway", "infosys campus", "wipro gate e-city", "velankani tech park", "e-city phase 1 toll"],
  },
  RD_BLR_21: {
    lanes: 4,
    lane_breakdown: ["Lane 1: Lake Perimeter Bypass", "Lane 2: Varthur Main Arterial"],
    speed_limit_kmh: 50.0,
    coordinates: [[12.9360, 77.7400], [12.9420, 77.7470], [12.9480, 77.7550]],
    place_aliases: ["varthur road", "kundalahalli gate", "varthur lake road", "whitefield south perimeter", "marathahalli-varthur road"],
  },
  RD_BLR_22: {
    lanes: 6,
    lane_breakdown: ["Lane 1: Metro Line 4 Ground Track", "Lane 2: Kanakapura Main Highway", "Lane 3: South Transit Express"],
    speed_limit_kmh: 60.0,
    coordinates: [[12.8980, 77.5700], [12.9050, 77.5750], [12.9120, 77.5800]],
    place_aliases: ["kanakapura road", "sarakki signal", "banashankari metro link", "art of living road", "konanakunte cross"],
  },
  RD_BLR_23: {
    lanes: 4,
    lane_breakdown: ["Lane 1: NGV Commercial Slip", "Lane 2: 80 Feet Transit Spine"],
    speed_limit_kmh: 45.0,
    coordinates: [[12.9350, 77.6140], [12.9400, 77.6200], [12.9450, 77.6260]],
    place_aliases: ["koramangala 80 feet road", "national games village", "ngv gate", "passport seva kendra koramangala", "regional passport office"],
  },
  RD_BLR_24: {
    lanes: 4,
    lane_breakdown: ["Lane 1: Market Pedestrian Friction Track", "Lane 2: Margosa Transit Flow"],
    speed_limit_kmh: 40.0,
    coordinates: [[12.9980, 77.5660], [13.0030, 77.5700], [13.0080, 77.5740]],
    place_aliases: ["malleshwaram 8th cross", "margosa road", "sampige road", "malleshwaram market", "kaadu malleswara temple", "18th cross malleshwaram"],
  },
};

export const CORRIDOR_FREE_FLOW_SPEEDS: Record<string, number> = {
  RD_BLR_01: 48.0, RD_BLR_02: 45.0, RD_BLR_03: 60.0, RD_BLR_04: 46.0,
  RD_BLR_05: 55.0, RD_BLR_06: 65.0, RD_BLR_07: 50.0, RD_BLR_08: 44.0,
  RD_BLR_09: 52.0, RD_BLR_10: 48.0, RD_BLR_11: 42.0, RD_BLR_12: 45.0,
  RD_BLR_13: 46.0, RD_BLR_14: 48.0, RD_BLR_15: 58.0, RD_BLR_16: 50.0,
  RD_BLR_17: 50.0, RD_BLR_18: 42.0, RD_BLR_19: 52.0, RD_BLR_20: 60.0,
  RD_BLR_21: 48.0, RD_BLR_22: 52.0, RD_BLR_23: 46.0, RD_BLR_24: 44.0,
};

const GPS_RAW: Record<string, [number, number, number]> = {
  RD_BLR_01: [12.9784, 77.6408, 48.0], RD_BLR_02: [12.9756, 77.6066, 45.0],
  RD_BLR_03: [13.0358, 77.5970, 60.0], RD_BLR_04: [12.9790, 77.6420, 46.0],
  RD_BLR_05: [13.0380, 77.5985, 55.0], RD_BLR_06: [12.8452, 77.6602, 65.0],
  RD_BLR_07: [12.9850, 77.7280, 50.0], RD_BLR_08: [12.9250, 77.5938, 44.0],
  RD_BLR_09: [12.9560, 77.7010, 52.0], RD_BLR_10: [12.9240, 77.6520, 48.0],
  RD_BLR_11: [12.9176, 77.6238, 42.0], RD_BLR_12: [12.9352, 77.6245, 45.0],
  RD_BLR_13: [12.9280, 77.5790, 46.0], RD_BLR_14: [12.9725, 77.6200, 48.0],
  RD_BLR_15: [13.0280, 77.5400, 58.0], RD_BLR_16: [13.0238, 77.5529, 50.0],
  RD_BLR_17: [12.9600, 77.6480, 50.0], RD_BLR_18: [12.9730, 77.6075, 42.0],
  RD_BLR_19: [13.0550, 77.6320, 52.0], RD_BLR_20: [12.8399, 77.6770, 60.0],
  RD_BLR_21: [12.9420, 77.7470, 48.0], RD_BLR_22: [12.9050, 77.5750, 52.0],
  RD_BLR_23: [12.9400, 77.6200, 46.0], RD_BLR_24: [13.0030, 77.5700, 44.0],
};

export const BENGALURU_CORRIDOR_GPS: Record<string, CorridorGpsEntry> = Object.fromEntries(
  Object.entries(GPS_RAW).map(([rid, [lat, lon, ff]]) => [
    rid,
    {
      name: ROAD_REGISTRY[rid]?.bangalore_name ?? rid,
      zone: ROAD_REGISTRY[rid]?.city_zone ?? "Indiranagar",
      lat,
      lon,
      free_flow: ff,
    },
  ])
);

export interface SectorRegionDefinition {
  region_id: string;
  city_zone: string;
  short_label: string;
  center: { lat: number; lng: number };
  polygon: [number, number][];
}

// 8 non-overlapping Bengaluru Metropolitan Sector polygons enclosing all 24 corridors
export const BENGALURU_SECTOR_REGIONS: SectorRegionDefinition[] = [
  {
    region_id: "REG_HEBBAL",
    city_zone: "Hebbal North",
    short_label: "Hebbal North",
    center: { lat: 13.043, lng: 77.614 },
    polygon: [
      [13.072, 77.586],
      [13.074, 77.648],
      [13.046, 77.654],
      [13.014, 77.624],
      [13.014, 77.584],
      [13.044, 77.582],
    ],
  },
  {
    region_id: "REG_YESHWANTHPUR",
    city_zone: "Yeshwanthpur West",
    short_label: "Yeshwanthpur",
    center: { lat: 13.018, lng: 77.552 },
    polygon: [
      [13.046, 77.522],
      [13.044, 77.578],
      [13.012, 77.580],
      [12.989, 77.578],
      [12.990, 77.542],
      [13.016, 77.520],
    ],
  },
  {
    region_id: "REG_CBD",
    city_zone: "M.G. Road CBD",
    short_label: "MG Road CBD",
    center: { lat: 12.974, lng: 77.608 },
    polygon: [
      [12.990, 77.588],
      [12.990, 77.628],
      [12.961, 77.628],
      [12.958, 77.596],
      [12.970, 77.586],
    ],
  },
  {
    region_id: "REG_INDIRANAGAR",
    city_zone: "Indiranagar",
    short_label: "Indiranagar",
    center: { lat: 12.972, lng: 77.648 },
    polygon: [
      [12.993, 77.632],
      [12.993, 77.674],
      [12.952, 77.672],
      [12.950, 77.633],
    ],
  },
  {
    region_id: "REG_WHITEFIELD",
    city_zone: "Whitefield",
    short_label: "Whitefield",
    center: { lat: 12.962, lng: 77.726 },
    polygon: [
      [12.999, 77.688],
      [13.001, 77.764],
      [12.931, 77.766],
      [12.929, 77.688],
    ],
  },
  {
    region_id: "REG_JAYANAGAR",
    city_zone: "Jayanagar",
    short_label: "Jayanagar",
    center: { lat: 12.919, lng: 77.582 },
    polygon: [
      [12.944, 77.560],
      [12.944, 77.604],
      [12.893, 77.602],
      [12.891, 77.560],
    ],
  },
  {
    region_id: "REG_KORAMANGALA",
    city_zone: "Koramangala",
    short_label: "Koramangala",
    center: { lat: 12.933, lng: 77.636 },
    polygon: [
      [12.948, 77.608],
      [12.948, 77.670],
      [12.916, 77.670],
      [12.916, 77.634],
      [12.924, 77.608],
    ],
  },
  {
    region_id: "REG_ECITY",
    city_zone: "Electronic City South",
    short_label: "Electronic City",
    center: { lat: 12.866, lng: 77.656 },
    polygon: [
      [12.921, 77.611],
      [12.913, 77.634],
      [12.860, 77.694],
      [12.825, 77.692],
      [12.826, 77.644],
      [12.888, 77.610],
    ],
  },
];

export const CALIBRATED_ROAD_LENGTHS_KM: Record<string, number> = {
  RD_BLR_01: 3.1, RD_BLR_02: 2.2, RD_BLR_03: 6.5, RD_BLR_04: 2.8,
  RD_BLR_05: 3.5, RD_BLR_06: 7.4, RD_BLR_07: 5.2, RD_BLR_08: 2.6,
  RD_BLR_09: 4.1, RD_BLR_10: 5.5, RD_BLR_11: 3.0, RD_BLR_12: 2.4,
  RD_BLR_13: 2.9, RD_BLR_14: 2.3, RD_BLR_15: 6.2, RD_BLR_16: 3.3,
  RD_BLR_17: 4.5, RD_BLR_18: 1.9, RD_BLR_19: 5.0, RD_BLR_20: 4.2,
  RD_BLR_21: 4.8, RD_BLR_22: 4.6, RD_BLR_23: 3.2, RD_BLR_24: 2.7,
};

export const INTER_ZONE_BRIDGES: [string, string, number][] = [
  ["RD_BLR_01", "RD_BLR_14", 2.8],
  ["RD_BLR_04", "RD_BLR_02", 3.6],
  ["RD_BLR_17", "RD_BLR_09", 4.5],
  ["RD_BLR_17", "RD_BLR_12", 3.2],
  ["RD_BLR_02", "RD_BLR_08", 5.0],
  ["RD_BLR_02", "RD_BLR_05", 6.2],
  ["RD_BLR_18", "RD_BLR_23", 4.1],
  ["RD_BLR_14", "RD_BLR_17", 2.6],
  ["RD_BLR_03", "RD_BLR_16", 5.8],
  ["RD_BLR_05", "RD_BLR_24", 4.9],
  ["RD_BLR_19", "RD_BLR_07", 8.5],
  ["RD_BLR_09", "RD_BLR_10", 5.2],
  ["RD_BLR_21", "RD_BLR_10", 6.8],
  ["RD_BLR_10", "RD_BLR_11", 4.2],
  ["RD_BLR_12", "RD_BLR_08", 4.4],
  ["RD_BLR_23", "RD_BLR_11", 3.5],
  ["RD_BLR_08", "RD_BLR_11", 4.8],
  ["RD_BLR_13", "RD_BLR_16", 7.5],
  ["RD_BLR_22", "RD_BLR_06", 6.0],
  ["RD_BLR_11", "RD_BLR_06", 3.8],
  ["RD_BLR_16", "RD_BLR_02", 6.4],
  ["RD_BLR_24", "RD_BLR_18", 5.5],
];

const INTERSECTION_NAME_MAP: Record<string, string> = {};
for (const info of Object.values(ROAD_REGISTRY)) {
  INTERSECTION_NAME_MAP[info.intersection_id] = info.intersection_name;
}

export function getRoadName(roadId: string): string {
  const info = ROAD_REGISTRY[roadId];
  return info ? info.bangalore_name || info.global_name || roadId : roadId;
}

export function getIntersectionName(intersectionId: string): string {
  return INTERSECTION_NAME_MAP[intersectionId] ?? intersectionId;
}

export function getRoadMetadata(roadId: string) {
  const info = ROAD_REGISTRY[roadId];
  return {
    road_id: roadId,
    road_name: getRoadName(roadId),
    road_type: info?.road_type ?? "Urban Arterial Corridor",
    intersection_id: info?.intersection_id ?? "",
    intersection_name: info?.intersection_name ?? info?.intersection_id ?? "",
    city_zone: info?.city_zone ?? "",
  };
}

export function getCorridorLaneInfo(roadId: string) {
  const geo = CORRIDOR_GEO_REGISTRY[roadId];
  return {
    road_id: roadId,
    lanes: geo?.lanes ?? 4,
    lane_breakdown: geo?.lane_breakdown ?? ["Lane 1: Through", "Lane 2: Through"],
    speed_limit_kmh: geo?.speed_limit_kmh ?? 50.0,
    coordinates: geo?.coordinates ?? [],
  };
}

export function getCorridorCoordinates(roadId: string): [number, number][] {
  return CORRIDOR_GEO_REGISTRY[roadId]?.coordinates ?? [];
}

export function normalizeCorridorId(corridorId: string, toCode = false): string {
  if (!corridorId || typeof corridorId !== "string") return "";
  const clean = corridorId.trim().toUpperCase();
  const mBlr = clean.match(/^BLR[-_]?COR[-_]?(\d+)$/);
  if (mBlr) {
    const num = String(parseInt(mBlr[1], 10)).padStart(2, "0");
    return toCode ? `BLR-COR-${num}` : `RD_BLR_${num}`;
  }
  const mRd = clean.match(/^RD[-_]?BLR[-_]?(\d+)$/);
  if (mRd) {
    const num = String(parseInt(mRd[1], 10)).padStart(2, "0");
    return toCode ? `BLR-COR-${num}` : `RD_BLR_${num}`;
  }
  return clean;
}

export function computeMfdDensity(
  flowQ: number,
  speedV: number,
  maxDensity = 150.0,
  minSpeed = 5.0
): number {
  const vSafe = Math.max(minSpeed, Number(speedV) || minSpeed);
  const qSafe = Math.max(0.0, Number(flowQ) || 0.0);
  const k = qSafe / vSafe;
  return Math.round(Math.min(maxDensity, Math.max(0.0, k)) * 100) / 100;
}

export function getCorridor(corridorId: string) {
  const normId = normalizeCorridorId(corridorId);
  if (!normId || !ROAD_REGISTRY[normId]) return null;

  const info = ROAD_REGISTRY[normId];
  const geo = CORRIDOR_GEO_REGISTRY[normId];
  const m = normId.match(/^RD_BLR_(\d+)$/);
  const code = m ? `BLR-COR-${String(parseInt(m[1], 10)).padStart(2, "0")}` : normId;
  const coords = geo?.coordinates ?? [];
  const path: [number, number][] = coords.map(([lat, lng]) => [lat, lng]);
  const speedLimit = geo?.speed_limit_kmh ?? 50.0;
  const ffSpeed = CORRIDOR_FREE_FLOW_SPEEDS[normId] ?? speedLimit;
  const intId = info.intersection_id || `INT_${normId.replace("RD_", "")}`;
  const intName = info.intersection_name || `${info.bangalore_name} Crossing`;
  const mid = coords.length > 0 ? coords[Math.floor(coords.length / 2)] : [12.9716, 77.5946];

  const junctions = [
    {
      junction_id: intId,
      intersection_id: intId,
      junction_name: intName,
      intersection_name: intName,
      lat: mid[0],
      lng: mid[1],
      control_type: "Actuated Signal",
      signal_status: "Operational",
      level_of_service: "Moderate",
      queue_meters: 35.0,
      control_delay_sec: 24.5,
    },
  ];

  return {
    corridor_id: normId,
    road_id: normId,
    corridor_code: code,
    code,
    name: info.bangalore_name,
    corridor_name: info.bangalore_name,
    bangalore_name: info.bangalore_name,
    global_name: info.global_name,
    zone: info.city_zone,
    city_zone: info.city_zone,
    road_type: info.road_type,
    lanes: geo?.lanes ?? 4,
    lane_breakdown: geo?.lane_breakdown ?? [],
    speed_limit: speedLimit,
    speed_limit_kmh: speedLimit,
    free_flow_speed: ffSpeed,
    free_flow_speed_kmh: ffSpeed,
    coordinates: coords,
    path,
    intersection_id: intId,
    intersection_name: intName,
    junctions,
    place_aliases: geo?.place_aliases ?? [],
  };
}

export function getAllCorridors() {
  return Object.keys(ROAD_REGISTRY)
    .map((id) => getCorridor(id))
    .filter((c): c is NonNullable<typeof c> => c !== null);
}

export function matchPlacesToCorridors(query: string, limit = 5) {
  if (!query || !query.trim()) {
    const defaultIds = ["RD_BLR_02", "RD_BLR_11", "RD_BLR_05", "RD_BLR_01", "RD_BLR_07"];
    return defaultIds
      .filter((id) => Boolean(ROAD_REGISTRY[id]))
      .map((id) => ({
        road_id: id,
        name: getRoadName(id),
        city_zone: ROAD_REGISTRY[id].city_zone,
        road_type: ROAD_REGISTRY[id].road_type,
        intersection_name: ROAD_REGISTRY[id].intersection_name,
        coordinates: getCorridorCoordinates(id),
        lanes: CORRIDOR_GEO_REGISTRY[id]?.lanes ?? 4,
        match_type: "landmark_hub",
      }));
  }

  const qClean = query.trim().toLowerCase();
  const qTokens = qClean.split(/[\s\-_,.]+/).filter((t) => t.length >= 3);
  const matches: Array<Record<string, unknown> & { score: number }> = [];

  for (const [rId, info] of Object.entries(ROAD_REGISTRY)) {
    const geo = CORRIDOR_GEO_REGISTRY[rId];
    const aliases = (geo?.place_aliases ?? []).map((a) => a.toLowerCase());
    const blrName = info.bangalore_name.toLowerCase();
    const globName = info.global_name.toLowerCase();
    const zone = info.city_zone.toLowerCase();
    const intName = info.intersection_name.toLowerCase();
    const allStrings = [blrName, globName, zone, intName, ...aliases];

    let score = 0;
    if (qClean === rId.toLowerCase()) {
      score = 100;
    } else if (aliases.some((a) => qClean === a) || qClean === blrName) {
      score = 95;
    } else if (aliases.some((a) => a.length >= 4 && (qClean.includes(a) || a.includes(qClean)))) {
      score = 85;
    } else if (qClean.includes(blrName) || blrName.includes(qClean) || qClean.includes(globName)) {
      score = 80;
    } else if ([intName, zone].some((s) => s.length >= 4 && (qClean.includes(s) || s.includes(qClean)))) {
      score = 65;
    } else if (qTokens.length > 0) {
      const matched = qTokens.filter((tok) => allStrings.some((cand) => cand.includes(tok))).length;
      if (matched >= Math.min(2, qTokens.length)) {
        score = 50 + matched * 10;
      }
    }

    if (score > 0) {
      matches.push({
        score,
        road_id: rId,
        name: info.bangalore_name,
        city_zone: info.city_zone,
        road_type: info.road_type,
        intersection_name: info.intersection_name,
        coordinates: geo?.coordinates ?? [],
        lanes: geo?.lanes ?? 4,
        lane_breakdown: geo?.lane_breakdown ?? [],
        match_type: score >= 80 ? "exact" : "alias",
      });
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, Math.max(1, limit));
}

export function enrichRoadInfo<T extends Record<string, unknown>>(roadDict: T) {
  const rId = String(roadDict.road_id ?? "");
  const meta = getRoadMetadata(rId);
  const laneInfo = getCorridorLaneInfo(rId);
  return {
    ...roadDict,
    road_name: meta.road_name,
    road_type: meta.road_type,
    intersection_name: meta.intersection_name,
    lanes: laneInfo.lanes,
    lane_breakdown: laneInfo.lane_breakdown,
    speed_limit_kmh: laneInfo.speed_limit_kmh,
    coordinates: laneInfo.coordinates,
  };
}
