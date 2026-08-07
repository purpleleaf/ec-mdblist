const crypto = require('crypto');
const needle = require('needle');

const algorithm = 'aes-256-cbc';
const secretPassword = process.env.ENCRYPTION_KEY || 'FallbackSicurezzaTemporaneo2026!';
const key = crypto.createHash('sha256').update(String(secretPassword)).digest();

function encrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    let encrypted = cipher.update(text, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return Buffer.concat([iv, encrypted]).toString('hex');
}

function decrypt(text) {
    try {
        const encryptedBuffer = Buffer.from(text, 'hex');
        const iv = encryptedBuffer.slice(0, 16);
        const encryptedText = encryptedBuffer.slice(16);
        const decipher = crypto.createDecipheriv(algorithm, key, iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return JSON.parse(decrypted.toString('utf8'));
    } catch (e) {
        console.error("[CRYPTO ERROR] Decifratura fallita:", e.message);
        return null;
    }
}

function getImdbId(obj) {
    const id = obj && (obj.imdb_id || obj.imdbId || obj.imdb);
    if (typeof id !== 'string') return null;
    if (!id.startsWith('tt')) return null;
    return id;
}

function mdbToStremio(obj) {
    const imdbId = getImdbId(obj);
    if (!imdbId) return null;
    return {
        id: imdbId,
        name: obj.title || obj.name,
        releaseInfo: (obj.release_year || '') + '',
        type: obj.mediatype === 'show' ? 'series' : 'movie',
        poster: `https://images.metahub.space/poster/small/${imdbId}/img`,
        description: ''
    };
}

function getFullTmdbData(imdbId, stremioType, tmdbKey, lang) {
    return new Promise((resolve) => {
        const tmdbType = stremioType === 'series' ? 'tv' : 'movie';
        const findUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${tmdbKey}&external_source=imdb_id&language=${lang}`;

        needle.get(findUrl, (err, resp, body) => {
            if (err || resp.statusCode !== 200 || !body) return resolve(null);
            
            const results = tmdbType === 'tv' ? body.tv_results : body.movie_results;
            if (!results || results.length === 0) return resolve(null);

            const tmdbId = results[0].id;
            const detailUrl = `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}?api_key=${tmdbKey}&language=${lang}&append_to_response=credits,videos,translations`;
            
            needle.get(detailUrl, (dErr, dResp, dBody) => {
                if (dErr || dResp.statusCode !== 200 || !dBody) return resolve(null);
                
                const genres = dBody.genres ? dBody.genres.map(g => g.name) : [];
                const cast = (dBody.credits && dBody.credits.cast) ? dBody.credits.cast.slice(0, 5).map(c => c.name) : [];
                let director = [];
                if (tmdbType === 'movie' && dBody.credits && dBody.credits.crew) {
                    director = dBody.credits.crew.filter(c => c.job === 'Director').map(c => c.name);
                } else if (tmdbType === 'tv' && dBody.created_by) {
                    director = dBody.created_by.map(c => c.name);
                }

                let trailerId = null;
                if (dBody.videos && dBody.videos.results) {
                    const ytVideo = dBody.videos.results.find(v => v.site === 'YouTube' && v.type === 'Trailer');
                    if (ytVideo) trailerId = ytVideo.key;
                }

                // --- CONTROLLO TRADUZIONE REALE ---
                const targetLang = lang.split('-')[0]; // es. 'it'

                // 1. Produzione originale nella lingua richiesta (es. film italiano)
                const isOriginalLanguage = dBody.original_language === targetLang;

                // 2. Trama (overview) in italiano restituita da TMDB e non vuota
                const hasOverview = Boolean(dBody.overview && dBody.overview.trim().length > 0);

                // 3. Verifica nel blocco traduzioni: deve esserci una trama tradotta O un titolo tradotto DIVERSO da quello originale
                let hasRealTranslation = false;
                if (dBody.translations && Array.isArray(dBody.translations.translations)) {
                    const trans = dBody.translations.translations.find(t => t.iso_639_1 === targetLang);
                    if (trans && trans.data) {
                        const translatedOverview = trans.data.overview ? trans.data.overview.trim() : "";
                        const translatedTitle = trans.data.title || trans.data.name || "";
                        const originalTitle = dBody.original_title || dBody.original_name || "";

                        hasRealTranslation = Boolean(
                            translatedOverview.length > 0 ||
                            (translatedTitle.length > 0 && originalTitle.length > 0 && translatedTitle.toLowerCase() !== originalTitle.toLowerCase())
                        );
                    }
                }

                // Un contenuto passa solo se ha una traduzione dimostrata
                const hasTranslation = isOriginalLanguage || hasOverview || hasRealTranslation;

                resolve({
                    name: dBody.title || dBody.name,
                    description: dBody.overview || "Nessuna trama disponibile.",
                    poster: dBody.poster_path ? `https://image.tmdb.org/t/p/w500${dBody.poster_path}` : null,
                    background: dBody.backdrop_path ? `https://image.tmdb.org/t/p/original${dBody.backdrop_path}` : null,
                    genres: genres,
                    cast: cast,
                    director: director,
                    trailer: trailerId,
                    hasTranslation: hasTranslation
                });
            });
        });
    });
}

module.exports = {
    encrypt,
    decrypt,
    mdbToStremio,
    getFullTmdbData
};
