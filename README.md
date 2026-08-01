# 🏴‍☠️ IlCorsaroViola - The Ultimate Italian Stremio Addon

<div align="center">

![Version](https://img.shields.io/badge/Version-5.0.0-brightgreen?style=for-the-badge)
![Node.js](https://img.shields.io/badge/Node.js-Backend-green?style=for-the-badge)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Database-blue?style=for-the-badge)
![Real-Debrid](https://img.shields.io/badge/Real--Debrid-Supported-orange?style=for-the-badge)
![TorBox](https://img.shields.io/badge/TorBox-Supported-blue?style=for-the-badge)

**Il motore di ricerca italiano per Stremio più avanzato e intelligente.**

[📦 Installa Addon](https://ilcorsaroviola-icv.hf.space) • 
[📦 Beta Version](https://icv.stremio.dpdns.org) •
[📊 Database](https://db.corsaroviola.dpdns.org/) • 
[📝 Changelog](CHANGELOG.md)

</div>

---

## 🚀 Che cos'è IlCorsaroViola?

IlCorsaroViola è un addon per Stremio progettato specificamente per l'utenza italiana. Non è solo un semplice scraper: è un **ecosistema intelligente** che impara e migliora con l'uso.

---

## 🧠 Database Dinamico & Self-Filling

La caratteristica più potente di IlCorsaroViola è il suo database "vivo":

| Caratteristica | Descrizione |
|----------------|-------------|
| **Popolamento Automatico** | Ogni ricerca alimenta il database centrale |
| **Cache Globale Condivisa** | Risultati istantanei per tutti gli utenti |
| **Auto-Aggiornamento** | Pack e film vengono arricchiti automaticamente |
| **TTL Intelligente** | Film: 18h, Serie: 10h per episodio |

> **Più lo usate, più diventa veloce e completo per tutti!** 🤝

---

## ✨ Funzionalità Principali

### 🔍 Ricerca Multi-Provider
- **IlCorsaroNero** - Tracker italiano principale
- **Knaben** - Meta-search engine
- **TorrentGalaxy** - Tracker internazionale
- **RARBG** - Database storico (proxy)
- **Jackett** - I tuoi indexer privati
- **E molti altri**

### ⚡ Performance & Debrid

| Servizio | Icona | Caratteristiche |
|----------|-------|-----------------|
| Real-Debrid | 👑 | Cache check istantaneo, RD link |
| Torbox | 📦 | Global + Personal cache |
| P2P | 🧲 | Fallback senza debrid |
| MediaFlow | 🕵️ | Proxy per condivisione sicura |

### 📦 Gestione Intelligente Pack (NEW v5.0)

Il sistema gestisce automaticamente i pack (stagioni complete, collection):

- **Selezione Episodio Automatica**: Da un pack stagionale, seleziona l'episodio richiesto
- **Selezione Film da Collection**: Da pack come "Trilogia", seleziona il film corretto
- **Cache DB Pack**: I file dei pack vengono salvati e riutilizzati
- **Verifica RD/Torbox**: Controlla quali pack sono già in cache debrid

### 🎬 Binge Watch Intelligente (NEW v5.0)

Continua a guardare nella **stessa qualità**:

```
Formato bingeGroup: icv|servizio|qualità|hdr|gruppo
Esempio: icv|rd|2160p|DV-HDR|FLUX
```

| Finisci episodio in... | Prossimo episodio in... |
|------------------------|-------------------------|
| 4K Dolby Vision | 4K Dolby Vision |
| 1080p SDR | 1080p SDR |
| 720p MeM group | 720p MeM group |

### 🔄 Cache Globale Condivisa (NEW v5.0)

- **Utente A** cerca "Interstellar" → 51 risultati salvati in cache
- **Utente B** cerca "Interstellar" → Risultati **istantanei** dalla cache
- **Filtri post-cache**: `full_ita` applicato dopo (non limita la cache)
- **Fresh Content Skip**: Contenuti < 4 giorni NON vengono cachati

### 📅 Fresh Content Protection

Problema risolto: episodio esce oggi, cache salva solo 720p, poi escono versioni 4K!

**Soluzione**: Skip cache per contenuti usciti da meno di **96 ore** (4 giorni)
- Copre ritardo release Italia vs USA
- Garantisce risultati completi per nuove uscite

---

## 🛠️ Configurazione

### Opzioni Principali

| Opzione | Descrizione |
|---------|-------------|
| **Real-Debrid API Key** | Chiave API Real-Debrid |
| **Torbox API Key** | Chiave API Torbox |
| **MediaFlow/EasyProxy Proxy URL** | Proxy per condivisione sicura |
| **Full ITA Mode** | Solo risultati con "ITA" nel titolo |
| **DB Only Mode** | Solo risultati dal database (velocissimo) |
| **Use Global Cache** | Usa/contribuisci alla cache condivisa |

### Provider Toggle

Ogni provider può essere abilitato/disabilitato:
- CorsaroNero, UIndex, Knaben, TorrentGalaxy
- RARBG, Torrentio, MediaFusion, Comet

---

## 📊 Sistema 3-Tier

| Tier | Fonte | Velocità | Descrizione |
|------|-------|----------|-------------|
| **Tier 1** | Cache Globale | ⚡ Istantaneo | Risultati già cercati da altri |
| **Tier 2** | Database PostgreSQL | 🚀 Veloce | Torrents salvati localmente |
| **Tier 3** | Provider Live | 🐢 Lento | Scraping in tempo reale |

---

## 📝 Changelog

Consulta il [CHANGELOG.md](CHANGELOG.md) per la lista completa delle modifiche.

### Novità v5.0.0 (Gennaio 2026)
- 🎬 **Binge Watch Intelligente** - Continuità qualità tra episodi
- 📦 **Pack Handler Completo** - Gestione automatica stagioni e collection
- 🔄 **Cache Globale** - Condivisione risultati tra utenti
- 📅 **Fresh Content Skip** - Protezione nuove uscite (< 4 giorni)
- 🔧 **Refactoring Completo** - Codebase ottimizzata

---

## 🤝 Contribuire

Il progetto è open source. Sentiti libero di aprire Issue o Pull Request.

---

<div align="center">

Made with ❤️ for the Italian Community

**v5.0.0** • Gennaio 2026

</div>

# Audit delle associazioni torrent / IMDb / TMDB

Lo script `scripts/audit-torrent-associations.cjs` simula la parte DB di una
richiesta Stremio, recupera i metadati da Cinemeta e classifica ogni torrent
associato come `valid`, `invalid` o `review`. Mostra inoltre l'avanzamento in
percentuale sul totale delle righe lette e controllate:

```bash
node scripts/audit-torrent-associations.cjs --imdb tt33764258
node scripts/audit-torrent-associations.cjs --tmdb 1368337
node scripts/audit-torrent-associations.cjs --all --limit 100
```

Per impostazione predefinita la connessione PostgreSQL e' forzata in sola
lettura. Copiare `.env.audit.example` in `.env.audit` e inserire li' `DB_HOST`,
`DB_PORT`, `DB_NAME`, `DB_USER` e `DB_PASSWORD`; in alternativa si puo' usare
`DATABASE_URL`. Il file `.env.audit` e' ignorato da Git. `TMDB_KEY` o
`TMDB_API_KEY` e' opzionale e aggiunge titolo italiano e titolo originale.

L'audit non si limita alla tabella `torrents`: per un film controlla anche le
righe di `pack_files` associate direttamente all'IMDb richiesto; per una serie
controlla le righe di `files`. Queste letture usano gli indici IMDb delle due
tabelle. I figli di una serie con un nome non conclusivo restano in stato
`review`, per evitare correzioni automatiche basate sul solo titolo episodio.
L'avanzamento viene scritto su stderr, cosi' `--json` mantiene stdout valido;
si puo' disabilitare con `--no-progress`.

Per scollegare dal film/serie soltanto le associazioni errate ad alta
confidenza e invalidare la relativa cache persistente:

```bash
node scripts/audit-torrent-associations.cjs --imdb tt33764258 --apply --yes
node scripts/audit-torrent-associations.cjs --all --apply --yes
```

Le righe `review` non vengono mai modificate automaticamente. Lo script non
cancella i torrent: azzera esclusivamente gli ID oggetto dell'audit, con una
condizione che verifica nuovamente i valori correnti dentro una transazione.
La modalita' `--apply` richiede un ruolo con permessi `UPDATE` su `torrents`,
`files` e `pack_files`, e `DELETE` su `torrent_search_cache`; un ruolo di sola
lettura puo' sempre usare il dry-run.
