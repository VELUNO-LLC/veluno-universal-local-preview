# Universal Local Preview for Phoenix Code

Eine plattformübergreifende Phoenix-Code-Extension, die lokale PHP-Projekte automatisch erkennt, einen PHP-Entwicklungsserver startet, ihn mit Phoenix Live Preview verbindet und statischen Text in PHP-Markup direkt in der Vorschau bearbeiten kann.

## Installation über Phoenix

Nach der Veröffentlichung im Phoenix Extension Marketplace:

1. In Phoenix Code rechts die Erweiterungsverwaltung öffnen.
2. Nach **Universal Local Preview** suchen.
3. **Installieren** wählen und Phoenix neu laden.

Neue Versionen erscheinen anschließend im Reiter **Installiert** als Update. Die lokale Node-Laufzeit ist nur in der Phoenix-Code-Desktop-App verfügbar.

## Aktueller Stand: 0.2.3

- ein Extension-Paket für macOS, Windows und Linux
- automatische Erkennung von statischen und PHP-Projekten
- Unterstützung für `index.php`, `public/index.php`, `web/index.php`, `composer.json` und verschachtelte PHP-Dateien
- automatische PHP-Suche im `PATH` und an verbreiteten Installationsorten
- native Projektpfade über Phoenix' plattformübergreifende VFS-Übersetzung
- einmalige manuelle PHP-Auswahl, falls die Laufzeit nicht gefunden wird
- automatisch gewählter freier Port auf `127.0.0.1`
- Start, Stop, Restart und „Im Browser öffnen“
- Statusanzeige in der Phoenix-Statusleiste
- visuelle Textbearbeitung per Doppelklick direkt in der PHP-Vorschau, auch bei `<br>` und gemischten Inline-Elementen
- eindeutige Quellzuordnung für direktes Markup und statische PHP-Stringwerte; bei Mehrdeutigkeit wird nicht geraten
- Editor-Injektion nur in die lokale Vorschau, ohne Hilfscode im Website-Projekt
- lokale Aufhebung von CSP-, X-Frame-Options- und Cross-Origin-Headern, die sichere Websites sonst im Phoenix-Vorschaufenster blockieren; die Website-Dateien und ihre produktiven Sicherheitsheader bleiben unverändert
- sauberes Beenden beim Projektwechsel und beim Schließen von Phoenix
- keine Shell-Befehlszusammensetzung und keine nativen Bibliotheken
- keine Änderungen an Website-Dateien oder `.brackets.json`
- lokale Vertrauensfreigabe, bevor Projektcode ausgeführt wird

Node-/Vite-Projekte werden bereits erkannt, aber in Version 0.2 bewusst noch nicht automatisch ausgeführt.

## Direkte Textbearbeitung

In einer laufenden PHP-Vorschau erscheint unten rechts „Direktbearbeitung: Text doppelklicken“. Ein Doppelklick auf einen einfachen Textknoten aktiviert die Bearbeitung. `Enter` oder ein Klick außerhalb speichert, `Escape` verwirft.

Die Erweiterung schreibt nur dann, wenn der sichtbare Text genau einer HTML-Stelle oder einem statischen, einfachen PHP-Stringwert zugeordnet werden kann. Texte mit `<br>` werden unterstützt. Aus Datenbanken, Berechnungen oder zusammengesetzten Ausdrücken erzeugter Inhalt wird absichtlich nicht automatisch überschrieben. Mehrdeutige Textstellen werden ebenfalls abgelehnt und müssen im Code bearbeitet werden.

## Dauerhafte lokale Installation

Die Node-Laufzeit ist nur in der Phoenix-Code-Desktop-App verfügbar. Die Erweiterung kann deshalb nicht in der Browser-Version auf `phcode.dev` betrieben werden.

Einige veröffentlichte Phoenix-Code-Versionen zeigen im Extension Manager keine Funktion zum Installieren einer lokalen ZIP-Datei. In diesem Fall wird das entpackte Paket direkt in Phoenix' Benutzer-Extensions-Ordner kopiert.

1. Phoenix Code vollständig beenden.
2. `dist/veluno-universal-local-preview-0.2.3.zip` entpacken.
3. Den entpackten Inhalt in einen Ordner namens `veluno-universal-local-preview` im Benutzer-Extensions-Ordner kopieren.
4. Prüfen, dass `package.json` unmittelbar in diesem Ordner liegt und keine zusätzliche Verzeichnisebene dazwischenliegt.
5. Phoenix Code neu starten.

Übliche Benutzer-Extensions-Ordner:

- macOS: `~/Library/Application Support/io.phcode/assets/extensions/user/veluno-universal-local-preview`
- Windows: `%APPDATA%\io.phcode\assets\extensions\user\veluno-universal-local-preview`
- Linux: `~/.config/io.phcode/assets/extensions/user/veluno-universal-local-preview`

Die Erweiterung bleibt dort dauerhaft installiert. Zum Aktualisieren Phoenix beenden und den Ordnerinhalt durch die neue Version ersetzen; zum Deinstallieren den Ordner entfernen.

## Veröffentlichung

Ein GitHub Release löst über `.github/workflows/publishToPhcode.yml` die Veröffentlichung im Phoenix Extension Marketplace aus. Vor dem Release muss die Versionsnummer in `package.json` erhöht und das Release-Paket exakt als `extension.zip` erzeugt werden:

```bash
npm run package:release
```

## Installation zum Entwickeln

1. Diesen Ordner in der Phoenix-Code-Desktop-App öffnen.
2. `Debug > Load Project As Extension` wählen.
3. Phoenix mit `Debug > Reload With Extensions` neu laden.
4. Einen HTML- oder PHP-Projektordner öffnen.

Die Extension benötigt die Desktop-App. Die Browser-Version von Phoenix stellt keine lokale Node-Laufzeit zum Starten von PHP bereit.

## PHP-Erkennung

Die Suche läuft in dieser Reihenfolge:

1. zuvor manuell ausgewähltes PHP-Programm
2. `PHP_BINARY` oder `PHP_PATH`
3. `php` aus dem Prozess-`PATH`
4. verbreitete Pfade für das jeweilige Betriebssystem
5. ausgewählte MAMP- beziehungsweise Laragon-Installationen

Wenn nichts gefunden wird, bietet Phoenix einen nativen Dateidialog zur Auswahl von `php` beziehungsweise `php.exe` an. Diese Auswahl wird global und nur lokal auf dem Computer gespeichert.

## Sicherheit

PHP-Projekte führen beim Aufruf serverseitigen Code aus. Deshalb verlangt die Extension pro Projekt eine einmalige lokale Freigabe. Abgelehnte Projekte werden nicht automatisch erneut gefragt; über `File > Local Preview Runtime > Preview starten` kann die Entscheidung wieder geöffnet werden.

Node- und Vite-Skripte werden in dieser Version nicht ausgeführt. Ein späterer Adapter muss dieselbe Vertrauensprüfung verwenden, da `npm run dev` beliebige Projekt-Skripte starten kann.

## Tests

```bash
npm test
```

Die Tests prüfen Syntax, Projekterkennung, Dokument-Roots, ausgeschlossene Abhängigkeitsordner, plattformspezifische PHP-Kandidaten und die Portvergabe. Wenn PHP auf dem Testsystem installiert ist, startet ein Integrationstest außerdem einen echten PHP-Server, ruft die Testseite ab und beendet ihn wieder.

Vor einer Veröffentlichung müssen zusätzlich manuelle Integrationstests mit den nativen Phoenix-Code-Builds auf macOS, Windows und Linux durchgeführt werden.
