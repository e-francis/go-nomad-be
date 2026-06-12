export interface Coords {
  origin: [number, number];
  dest: [number, number];
}

export interface Stop {
  city: string;
  coords: [number, number];
  activity: string;
  conditions: string;
}

export interface AirlinePrices {
  economy: string;
  business: string;
  first: string;
}

export interface Airline {
  name: string;
  type: string;
  route: string;
  hub: string;
  originCity: string;
  originCoords?: [number, number];
  destCoords?: [number, number];
  prices: AirlinePrices;
  stops?: Stop[];
}

export interface Plan {
  header: string;
  arrivalHub: string;
  coords: Coords;
  visa: {
    status: string;
    reqs: string[];
    checklist: string[];
  };
  airlines: Airline[];
  bestTime: string;
  spend: {
    total: string;
    breakdown: {
      flights: string;
      visa: string;
      stay: string;
      daily: string;
      transport: string;
    };
  };
  tourGuides: {
    name: string;
    specialty: string;
    contact: string;
    price: string;
  }[];
  unescoSites: string[];
  funFact: string;
  itinerary: {
    day: number;
    title: string;
    activities: { main: string; alt: string }[];
    meal: string;
  }[];
  stays: {
    type: string;
    name: string;
    price: string;
    desc: string;
  }[];
  tips: string[];
}

export interface ComparisonResult {
  destination: string;
  plan: Plan | null;
  error?: string;
}

export interface PackingList {
  essentials: string[];
  clothes: string[];
  gadgets: string[];
}

export interface Phrase {
  phrase: string;
  local: string;
  pron: string;
}
