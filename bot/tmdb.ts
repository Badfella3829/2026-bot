
import axios from 'axios';

const TMDB_API_KEY = process.env.TMDB_API_KEY || "7bffed716d50c95ed1c4790cfab4866a";
const BASE_URL = 'https://tmdbdk.dktczn.workers.dev/tmdb';

export interface TMDBSearchResult {
    id: number;
    title: string;
    original_title: string;
    overview: string;
    poster_path: string | null;
    backdrop_path: string | null;
    release_date: string;
    vote_average: number;
    media_type: 'movie' | 'tv';
}

export async function searchTMDB(query: string, type: 'movie' | 'tv' | 'multi' = 'multi'): Promise<TMDBSearchResult[]> {
    if (!TMDB_API_KEY) {
        throw new Error('TMDB_API_KEY is not set in environment variables');
    }

    try {
        const response = await axios.get(`${BASE_URL}/search/${type}`, {
            params: {
                api_key: TMDB_API_KEY,
                query: query,
                include_adult: false,
                language: 'en-US',
                page: 1
            }
        });

        return response.data.results || [];
    } catch (error) {
        console.error('TMDB Search Error:', error);
        return [];
    }
}

export async function getTMDBDetails(id: number, type: 'movie' | 'tv'): Promise<TMDBSearchResult | null> {
    if (!TMDB_API_KEY) {
        throw new Error('TMDB_API_KEY is not set');
    }

    try {
        const response = await axios.get(`${BASE_URL}/${type}/${id}`, {
            params: {
                api_key: TMDB_API_KEY,
                language: 'en-US'
            }
        });
        return response.data;
    } catch (error) {
        console.error('TMDB Details Error:', error);
        return null;
    }
}
