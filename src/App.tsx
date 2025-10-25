import useArcgis from "./hooks/useArcgis";
import { Link } from "react-router-dom";

function App() {
  useArcgis();

  return (
    <main className="p-4 h-screen flex flex-col items-center justify-center">
      <div className="flex flex-col gap-6 items-center">
        <img src="/shield.png" alt="shelter app logo" className="max-w-32" />
        <div>
          <h2 className="text-3xl text-center font-bold mb">SHELTER</h2>
          <p className="text-muted text-center">Navigate to safety</p>
        </div>
      </div>
      
      <div className="flex bg-warning/10 w-full rounded-md p-4 justify-between items-center mt-8">
        <div className="flex">
          <div className="h-4 w-4 mt-1 mr-4 bg-warning/50 rounded-full flex justify-center items-center">
            <div className="h-2 w-2 bg-warning rounded-full"></div>
          </div>
          <div>
            <p className="p-0">Active threat</p>
            <p className="text-2xl font-bold p-0">Missile attack</p>
          </div>
        </div>
        <img
          src="/rocket.png"
          alt="rocket image"
          className="max-h-full w-auto object-contain"
        />
      </div>

      <div className="flex flex-col w-full gap-3 mt-6">
        <a href="/navigate" className="bg-primary p-3 rounded-md text-white font-bold flex gap-2 items-center justify-center"><img src="/gps.png" alt="gps image" />Find safe shelter</a>
        <Link to="/map" className="bg-muted-foreground p-3 rounded-md text-black font-bold flex gap-2 justify-center items-center">
          <img src="/pin.png" alt="map pin image" />Shelter map
        </Link>
      </div>
    </main>
  );
}

export default App;
