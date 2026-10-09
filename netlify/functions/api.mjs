// Netlify Functions（V2形式）。/api/* をすべてここで受ける。
// V2形式なので Netlify Blobs のサイト情報は自動で渡される（トークン設定は不要）。
import { handle } from '../../lib/router.mjs';

export default async (request) => handle(request);

export const config = { path: '/api/*' };
