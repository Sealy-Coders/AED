"use client";

import { useRef } from "react";
import CitySearch, { type CitySearchTarget } from "./components/CitySearch";
import PolandCommunesMap, {
  type PolandCommunesMapHandle,
} from "./components/PolandCommunesMap";

export default function Home() {
  const mapRef = useRef<PolandCommunesMapHandle>(null);

  const handleCitySelect = (target: CitySearchTarget) => {
    mapRef.current?.flyToLocation(target.longitude, target.latitude);
  };

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <header className="mb-5">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Mapa gmin Polski
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Województwa → powiaty → gminy. Kolor zależy od liczby defibrylatorów.
          </p>
        </header>

        <div className="grid min-h-[520px] gap-4 lg:h-[min(75vh,720px)] lg:grid-cols-[minmax(0,1fr)_320px]">
          <PolandCommunesMap ref={mapRef} />
          <CitySearch onSelect={handleCitySelect} />
        </div>
      </div>
    </main>
  );
}
