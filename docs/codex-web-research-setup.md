# Codex-Webrecherche in LLM Wiki

Einrichtung 12.09.2026. LLM Wiki nutzt seine bestehende Deep-Research-Funktion mit einem lokalen Codex-Suchadapter und anschließender Codex-Synthese. Das ist keine eingebettete ChatGPT-Deep-Research-Oberfläche.

## Verwendung

Projekt öffnen, **Deep Research** wählen, Thema eingeben, **Start Research**. Nach Abschluss entsteht eine Wiki-Seite mit Quellen. Zunächst einen Rechercheauftrag gleichzeitig starten.

## Einrichtung

- **LLM Models:** aktives Profil **ChatGPT / Codex Research**, OpenAI-kompatibel, Endpoint `http://127.0.0.1:19829/v1`, Modell `gpt-6-astra`, API-Key leer, Streaming aus. Der lokale Adapter verwendet die vorhandene ChatGPT-Anmeldung der Codex-CLI.
- **External Information Sources:** Web Search; SearXNG-Schnittstelle; http://127.0.0.1:19829; General. Dahinter läuft der Codex-Adapter.
- Dienst: `scripts/codex_wiki_provider.py`; Suchbibliothek: `scripts/codex_search_bridge.py`. Tests: `scripts/test_codex_wiki_provider.py` und `scripts/test_codex_search_bridge.py`. Nur Python-Standardbibliothek. Die Synthese übernimmt ausschließlich die letzte abgeschlossene Modellantwort, damit Fortschrittsmeldungen nicht im Bericht landen.
- Dienst: ~/Library/LaunchAgents/de.bruniqo.llmwiki.codex-search.plist. Start bei Benutzeranmeldung. Die registrierte SSD muss vorhanden sein.
- Health: curl http://127.0.0.1:19829/health. Health bestätigt Erreichbarkeit; ein Suchtest prüft Anmeldung und Modellzugang.

## Grenzen

Suchbegriffe gehen an Codex/OpenAI; Authentifizierung bleibt bei Codex. Keine zusätzlichen Tokens werden gespeichert. Keine Suchbegriffe, Modellantworten oder Zugangsdaten in Adapterlogs. Dienst nur auf 127.0.0.1, Browser-Fetch-Anfragen werden abgewiesen; die native App darf den lokalen Endpoint verwenden. Recherchethema und übergebene Quellenauszüge werden zur Synthese an Codex/OpenAI übertragen.

Der Suchdienst verwendet gpt-5.6-luna mit niedriger Reasoning-Stufe; die Synthese verwendet gpt-6-astra. Die Suche hat 25 Sekunden Zeit, die App maximal 30 Sekunden. Die Synthese hat 180 Sekunden Zeit. Je eine Suche und eine Synthese können gleichzeitig laufen. Eine Suche gleichzeitig; weitere gleichzeitige Anfragen erhalten einen Fehler. Zwischenspeicher im RAM: fünf Minuten, maximal 32 Anfragen. Bei Zeitlimit/Auslastung erneut versuchen.

Ergebnisse erfordern einen abgeschlossenen Websuchaufruf und Modellabschluss. URLs werden auf öffentliche HTTP(S)-Adressen geprüft. Die CLI-Suchereignisse liefern keine unabhängige vollständige Trefferliste. Quellenzusammenfassungen sind modellgeneriert; wichtige Aussagen anhand der Originalquellen prüfen.

## Betrieb

Status: launchctl print gui/$(id -u)/de.bruniqo.llmwiki.codex-search

Bei inaktiver Recherche anhalten: launchctl bootout gui/$(id -u)/de.bruniqo.llmwiki.codex-search

Start: launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/de.bruniqo.llmwiki.codex-search.plist

Vor Deaktivierung eine andere funktionierende Suchquelle in der App auswählen. Kein nativer App-Build und kein Austausch des App-Bundles nötig.

## Nachweise

43 Tests bestanden (6,610 Sekunden, lokaler unittest-Lauf). Suchtest und Funktionstest des neuen Profils in der App bestanden. Abschließender Quellenbericht wird separat im Codex-Worklog belegt.

Ein einzelner Review-Auftrag kann mehrere Suchanfragen parallel starten. Der Adapter nimmt aktuell nur eine gleichzeitig an; weitere werden mit HTTP 429 abgewiesen. Dadurch können solche Aufgaben nur teilweise mit Quellen versorgt werden. Für vollständige Mehrfachrecherchen die Teilfragen einzeln über Deep Research starten.

Bei SIGTERM/SIGINT beendet der Dienst seine registrierten CLI-Prozessgruppen; neue Starts werden während des Herunterfahrens verhindert. Für einen abrupten SIGKILL oder Betriebssystemabsturz kann der Prozess selbst keine Bereinigung garantieren.

Der Dienst startet `/Users/alessandro/.local/bin/codex` explizit. Kein zusätzlicher OpenAI-Platform-API-Schlüssel nötig. Native Codex-CLI-Profile können weiterhin für Ingest verwendet werden. Projektbezogene Modell-Overrides haben Vorrang vor dem globalen Research-Profil.

## Erfolgreicher App-Durchlauf

Am 12.09.2026 wurde „Python pathlib official documentation“ über Deep Research vollständig gesucht, synthetisiert und als `Coding/wiki/queries/research-python-pathlib-official-documentation-2026-09-12-213459-research-9.md` gespeichert. Zwei offizielle Quellen, keine internen Fortschrittsmeldungen; SHA-256 `0d88bdafe738b576c9ae2cbb1946a88b71bbf1e8ca75590be77e74b7742c1a38`. Die Seite wurde mit 12 Vektorchunks indexiert. My-llm-wiki übernimmt nun ebenfalls das globale Research-Profil (alter Override deaktiviert).
