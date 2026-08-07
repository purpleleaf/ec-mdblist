const express = require('express');
const cors = require('cors');
const needle = require('needle');
const path = require('path');
const tmdbLanguages = require('./languages');
const core = require('./core');

const app = express();
app.use(cors());
app.use(express.static('public')); 
app.use(express.static('views'));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));


// ==========================================
// 1. CONFIGURATION INTERFACE ROUTES
// ==========================================

app.get(['/', '/configure'], (req, res) => {
    res.render('config', {
        languages: tmdbLanguages,
        baseUrl: `${req.protocol}://${req.get('host')}`,
        spacePath: process.env.SPACE_ID || 'username/space-name',
        prefill: {
            mdbKey: '',
            tmdbKey: '',
            lang: 'en-US',
            allLists: true,
            search: false,
            strictLanguage: true,
            lists: '[]'
        }
    });
});

app.get('/get-lists', (req, res) => {
    const { mdb, tmdb } = req.query;
    if (!mdb || !tmdb) return res.json({ valid: false, error: "Missing API Keys" });

    needle.get(`https://api.themoviedb.org/3/configuration?api_key=${tmdb.trim()}`, (errTmdb, respTmdb) => {
        if (errTmdb || respTmdb.statusCode !== 200) return res.json({ valid: false, error: "Invalid TMDB Key" });

        needle.get(`https://api.mdblist.com/lists/user?apikey=${mdb.trim()}`, (errMdb, respMdb, bodyMdb) => {
            if (errMdb || respMdb.statusCode !== 200 || bodyMdb.error) return res.json({ valid: false, error: "Invalid MDBList Key" });
            
            const lists = Array.isArray(bodyMdb) ? bodyMdb : (bodyMdb.lists || []);
            res.json({ 
                valid: true, 
                lists: lists.map(l => ({ 
                    id: String(l.id || l.slug), 
                    name: l.name,
                    mediatype: l.mediatype || l.type || 'mixed'
                })) 
            });
        });
    });
});

app.get('/generate', (req, res) => {
    const { mdb, tmdb, lang, lists, all, search, strict } = req.query;
    
    const configData = {
        mdbKey: mdb.trim(),
        tmdbKey: tmdb.trim(),
        lang: lang || 'en-US',
        allLists: all === 'true',
        search: search === 'true',
        strictLanguage: strict === 'true'
    };

    if (all !== 'true') {
        try { configData.lists = JSON.parse(lists); } catch(e) { return res.status(400).send("Invalid list format"); }
    }

    const encryptedToken = core.encrypt(JSON.stringify(configData));
    res.json({ token: encryptedToken });
});

// ==========================================
// 2. ROTTE STREMIO (Addon Core)
// ==========================================

app.get('/manifest.json', (req, res) => {
    const baseManifest = {
        "id": "com.mdblist.translator",
        "version": "1.4.3",
        "name": "Ec Mdblist", 
        "description": "Bridge between easyCatalog and MDBList",
        "logo": `${req.protocol}://${req.get('host')}/logo.png`, 
        "resources": ["catalog", "meta"],
        "types": ["movie", "series"],
        "idPrefixes": ["tt"],
        "catalogs": [], 
        "behaviorHints": {
            "configurable": true,
            "configurationRequired": true
        },
        "stremioAddonsConfig": {
            "issuer": "https://stremio-addons.net",
            "signature": "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..xWQdMsBP65NdtpPIYRzEhQ.avd3fgmkqJTuLYo6gQ9dOe1wGZUa9uyvlLXN2n-lv0RGdQn6cl9HJrbVVp6bBo58pSAhPltzaCKs6ncEAimogPw5Ji9kggHmj34jckW-30eWr720U8emXzRnQaN3u7Bj.vhpysUlYp4eVp2hZe1oa5w"
        }
    };
    
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.json(baseManifest);
});

app.get('/:token/configure', (req, res) => {
    const config = core.decrypt(req.params.token) || {};
    res.render('config', {
        languages: tmdbLanguages,
        baseUrl: `${req.protocol}://${req.get('host')}`,
        spacePath: process.env.SPACE_ID || 'username/space-name',
        prefill: {
            mdbKey: config.mdbKey || '',
            tmdbKey: config.tmdbKey || '',
            lang: config.lang || 'en-US', 
            allLists: config.allLists !== undefined ? config.allLists : true,
            search: config.search !== undefined ? config.search : false,
            strictLanguage: config.strictLanguage !== undefined ? config.strictLanguage : true,
            lists: config.lists ? JSON.stringify(config.lists) : '[]'
        }
    });
});

app.get('/:token/manifest.json', (req, res) => {
    const config = core.decrypt(req.params.token);
    if (!config) return res.status(401).send("Invalid Token");

    const catalogs = [];
    const catalogExtra = [{ name: "skip", isRequired: false }];
    
    if (config.search) {
        catalogs.unshift({ id: "mdb-search", type: "series", name: "TMDB Search", extra: [{ name: "search", isRequired: true }] });
        catalogs.unshift({ id: "mdb-search", type: "movie", name: "TMDB Search", extra: [{ name: "search", isRequired: true }] });
    }

    if (config.allLists) {
        catalogs.push({ id: "mdb-all-movies", type: "movie", name: "MDBList All Movies", extra: catalogExtra });
        catalogs.push({ id: "mdb-all-series", type: "series", name: "MDBList All Series", extra: catalogExtra });
    } else if (config.lists && config.lists.length > 0) {
        config.lists.forEach(l => {
            const media = (l.mediatype || l.type || 'mixed').toLowerCase();

            if (media === 'movie' || media === 'movies') {
                catalogs.push({ id: `mdb-${l.id}`, type: "movie", name: l.name, extra: catalogExtra });
            } else if (media === 'show' || media === 'shows' || media === 'series' || media === 'tv') {
                catalogs.push({ id: `mdb-${l.id}`, type: "series", name: l.name, extra: catalogExtra });
            } else {
                catalogs.push({ id: `mdb-${l.id}`, type: "movie", name: l.name, extra: catalogExtra });
                catalogs.push({ id: `mdb-${l.id}`, type: "series", name: l.name, extra: catalogExtra });
            }
        });
    }

    const manifest = {
        "id": "com.mdblist.translator",
        "version": "1.4.3",
        "name": "MDBList Translator",
        "description": `Your MDBList catalogs with perfect TMDB metadata (${config.lang})`,
        "logo": `${req.protocol}://${req.get('host')}/logo.png`, 
        "background": `${req.protocol}://${req.get('host')}/background.png`,
        "resources": ["catalog", "meta"],
        "types": ["movie", "series"],
        "idPrefixes": ["tt"],
        "catalogs": catalogs,
        "behaviorHints": {
            "configurable": true
        },
        "stremioAddonsConfig": {
            "issuer": "https://stremio-addons.net",
            "signature": "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..xWQdMsBP65NdtpPIYRzEhQ.avd3fgmkqJTuLYo6gQ9dOe1wGZUa9uyvlLXN2n-lv0RGdQn6cl9HJrbVVp6bBo58pSAhPltzaCKs6ncEAimogPw5Ji9kggHmj34jckW-30eWr720U8emXzRnQaN3u7Bj.vhpysUlYp4eVp2hZe1oa5w"
        }
    };
    
    res.setHeader('Cache-Control', 'no-cache');
    res.json(manifest);
});

// ==========================================
// 3. LOGICA DI ELABORAZIONE E API HANDLERS
// ==========================================

function processItems(items, type, skip, config, res) {
    let stremioItems = items.map(core.mdbToStremio).filter(i => i && i.type === type);
    stremioItems = Array.from(new Map(stremioItems.map(item => [item.id, item])).values());

    if (stremioItems.length === 0) return res.json({ metas: [] });

    Promise.all(stremioItems.map(item => {
        return core.getFullTmdbData(item.id, item.type, config.tmdbKey, config.lang).then(tmdbData => {
            if (tmdbData) {
                if (config.strictLanguage && !tmdbData.hasTranslation) {
                    return null;
                }

                item.name = tmdbData.name || item.name;
                item.description = tmdbData.description || item.description;
                item.poster = tmdbData.poster || item.poster;
                
                let metaLinks = [];
                if (tmdbData.genres && tmdbData.genres.length > 0) {
                    metaLinks.push(...tmdbData.genres.map(genre => ({ name: genre, category: "Genres", url: `stremio:///discover/https%3A%2F%2Fv3-cinemeta.strem.io%2Fmanifest.json/${item.type}/top?genre=${encodeURIComponent(genre)}` })));
                }
                if (tmdbData.cast && tmdbData.cast.length > 0) {
                    metaLinks.push(...tmdbData.cast.map(actor => ({ name: actor, category: "Cast", url: `stremio:///search?search=${encodeURIComponent(actor)}` })));
                }
                if (tmdbData.director && tmdbData.director.length > 0) {
                    metaLinks.push(...tmdbData.director.map(dir => ({ name: dir, category: "Directors", url: `stremio:///search?search=${encodeURIComponent(dir)}` })));
                }
                if (metaLinks.length > 0) item.links = metaLinks;
                if (tmdbData.trailer) item.trailers = [{ source: tmdbData.trailer, type: "Trailer" }];
                
                return item;
            }
            return null;
        });
    })).then(allMetas => {
        const validMetas = allMetas.filter(m => m !== null);
        const page = validMetas.slice(skip, skip + 30);

        res.setHeader('Cache-Control', 'no-cache');
        res.json({ metas: page });
    });
}

const catalogHandler = (req, res) => {
    const config = core.decrypt(req.params.token);
    if (!config) return res.json({ metas: [] });

    const type = req.params.type;
    const catId = req.params.id.replace('mdb-', '');
    
    let skip = 0;
    let searchTerm = null;

    if (req.params.extra) {
        if (req.params.extra.includes('skip=')) {
            const match = req.params.extra.match(/skip=(\d+)/);
            if (match) skip = parseInt(match[1], 10);
        }
        if (req.params.extra.includes('search=')) {
            const match = req.params.extra.match(/search=([^&]+)/);
            if (match) searchTerm = decodeURIComponent(match[1]);
        }
    }

    if (catId === 'search' && searchTerm) {
        needle.get(`https://api.themoviedb.org/3/search/multi?api_key=${config.tmdbKey}&query=${encodeURIComponent(searchTerm)}&language=${config.lang}`, (err, resp, body) => {
            if (err || resp.statusCode !== 200 || !body || !body.results) return res.json({ metas: [] });
            
            const validResults = body.results.filter(r => r.media_type === 'movie' || r.media_type === 'tv').slice(0, 15);
            
            Promise.all(validResults.map(r => {
                return new Promise(resolve => {
                    needle.get(`https://api.themoviedb.org/3/${r.media_type}/${r.id}/external_ids?api_key=${config.tmdbKey}`, (e, r2, b2) => {
                        if (!e && r2.statusCode === 200 && b2 && b2.imdb_id) {
                            resolve({
                                imdb_id: b2.imdb_id,
                                title: r.title || r.name,
                                mediatype: r.media_type === 'tv' ? 'show' : 'movie'
                            });
                        } else {
                            resolve(null);
                        }
                    });
                });
            })).then(mockedMdbItems => {
                const finalItems = mockedMdbItems.filter(i => i !== null);
                processItems(finalItems, type, skip, config, res);
            });
        });
        return;
    }

    if (catId.startsWith('all-')) {
        needle.get(`https://api.mdblist.com/lists/user?apikey=${config.mdbKey}`, (err, resp, body) => {
            if (err || resp.statusCode !== 200) return res.json({ metas: [] });
            
            const lists = Array.isArray(body) ? body : (body.lists || []);
            const promises = lists.map(l => new Promise(resolve => {
                const idOrSlug = l.id || l.slug;
                needle.get(`https://api.mdblist.com/lists/${encodeURIComponent(idOrSlug)}/items/?apikey=${config.mdbKey}`, (e, r, b) => {
                    if (!e && r.statusCode === 200 && b) {
                        resolve(Array.isArray(b) ? b : [].concat(b.movies||[], b.shows||[], b.items||[]));
                    } else {
                        resolve([]);
                    }
                });
            }));
            
            Promise.all(promises).then(allResults => {
                let allItems = [];
                allResults.forEach(arr => allItems = allItems.concat(arr));
                processItems(allItems, type, skip, config, res);
            });
        });
    } else {
        needle.get(`https://api.mdblist.com/lists/${encodeURIComponent(catId)}/items/?apikey=${config.mdbKey}`, (err, resp, b) => {
            if (err || resp.statusCode !== 200 || !b) return res.json({ metas: [] });
            const items = Array.isArray(b) ? b : [].concat(b.movies||[], b.shows||[], b.items||[]);
            processItems(items, type, skip, config, res);
        });
    }
};

app.get('/:token/catalog/:type/:id.json', catalogHandler);
app.get('/:token/catalog/:type/:id/:extra.json', catalogHandler);

app.get('/:token/meta/:type/:id.json', (req, res) => {
    const config = core.decrypt(req.params.token);
    const { type, id } = req.params;
    
    if (!config) return res.json({ meta: { id: id, type: type, name: "Errore Token" } });

    needle.get(`https://v3-cinemeta.strem.io/meta/${type}/${id}.json`, (err, resp, bodyCine) => {
        let baseMeta = (bodyCine && bodyCine.meta) ? bodyCine.meta : { id: id, type: type, name: "Caricamento..." };

        core.getFullTmdbData(id, type, config.tmdbKey, config.lang).then(tmdbData => {
            if (tmdbData) {
                baseMeta.name = tmdbData.name || baseMeta.name;
                baseMeta.description = tmdbData.description || baseMeta.description || "Nessuna trama disponibile.";
                if (tmdbData.poster) baseMeta.poster = tmdbData.poster;
                if (tmdbData.background) baseMeta.background = tmdbData.background;
                if (tmdbData.trailer) baseMeta.trailers = [{ source: tmdbData.trailer, type: "Trailer" }];
            }
            res.setHeader('Cache-Control', 'no-cache');
            res.json({ meta: baseMeta });
        });
    });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Addon in esecuzione sulla porta ${port}`);
});
