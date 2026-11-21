import PolandCommunesMap from "./components/PolandCommunesMap";

export default function Home() {
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

        <div className="h-[min(75vh,720px)]">
          <PolandCommunesMap />
        </div>
      </div>
    </main>
  );
}
