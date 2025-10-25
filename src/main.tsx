import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import MapPage from "./pages/MapPage";
import NavigatePage from "./pages/NavigatePage";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<App />} />
          <Route path="/map" element={<MapPage />} />
          <Route path="/navigate" element={<NavigatePage />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);
