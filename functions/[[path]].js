import { createSupabaseClient } from './utils/supabase';

// Bot detection
function isBot(userAgent) {
    if (!userAgent) return true;
    const ua = userAgent.toLowerCase();
    const bots = [
        'facebookexternalhit', 'twitterbot', 'whatsapp', 'linkedinbot',
        'pinterest', 'slackbot', 'telegrambot', 'discordbot', 'googlebot',
        'bingbot', 'yandex', 'duckduckgo', 'baidu', 'ahern', 'instagram',
        'mj12bot', 'semrush', 'ahrefs', 'dotbot', 'rogerbot', 'exabot'
    ];
    return bots.some(bot => ua.includes(bot));
}

// OS Detection
function detectOS(userAgent) {
    if (!userAgent) return 'Unknown';
    const ua = userAgent.toLowerCase();
    if (ua.includes('iphone') || ua.includes('ipad')) return 'iOS';
    if (ua.includes('android')) return 'Android';
    if (ua.includes('windows phone')) return 'Windows Phone';
    if (ua.includes('windows')) return 'Windows';
    if (ua.includes('mac os') || ua.includes('macintosh')) return 'macOS';
    if (ua.includes('linux')) return 'Linux';
    if (ua.includes('cros')) return 'Chrome OS';
    return 'Unknown';
}

async function recordClick(supabase, link, request) {
    const userAgent = request.headers.get('user-agent') || '';

    // Skip bot tracking
    if (isBot(userAgent)) return;

    // 1. Extract click_id from Request URL (Dynamic - Priority)
    const requestUrl = new URL(request.url);
    let clickId = requestUrl.searchParams.get('click_id') ||
        requestUrl.searchParams.get('clickid') ||
        requestUrl.searchParams.get('subid') ||
        requestUrl.searchParams.get('gclid') ||
        requestUrl.searchParams.get('fbclid');

    // 2. If not in request, check Target URL (Static/Hardcoded)
    if (!clickId && link.original_url) {
        try {
            const targetUrl = new URL(link.original_url);
            clickId = targetUrl.searchParams.get('click_id') ||
                targetUrl.searchParams.get('clickid') ||
                targetUrl.searchParams.get('subid');
        } catch (e) { /* ignore */ }
    }

    // STRICT FILTER: If no click_id in EITHER, do NOT log
    if (!clickId) {
        return;
    }

    const country = request.cf?.country || 'XX';
    const ip = request.headers.get('cf-connecting-ip') || '0.0.0.0';
    const os = detectOS(userAgent);

    try {
        await supabase.from('clicks').insert({
            link_id: link.id,
            slug: link.slug,
            country: country,
            user_agent: userAgent.substring(0, 500),
            ip_address: ip,
            click_id: clickId,
            os: os
        });
    } catch (err) {
        console.error('Click tracking error:', err);
    }
}

export async function onRequest(context) {
    const url = new URL(context.request.url);
    const path = url.pathname.replace(/^\/+|\/+$/g, ''); // Remove leading/trailing slashes

    // Passthrough for API, assets, files (with extension), or root
    if (path.startsWith('api/') || path.startsWith('assets/') || path === '' || path.includes('.')) {
        return context.next();
    }

    const supabase = createSupabaseClient(context.env);

    // 1. Fetch Link
    const { data: link, error } = await supabase
        .from('links')
        .select(`
            *,
            domains ( url )
        `)
        .eq('slug', path)
        .single();

    if (error || !link) {
        // Not found -> serve SPA index.html for frontend routing
        const assetUrl = new URL('/', context.request.url);
        return context.env.ASSETS.fetch(assetUrl);
    }

    // 2. Anti-Spam / Bot Check
    const userAgent = context.request.headers.get('user-agent');
    if (!userAgent) {
        return new Response('Access Denied', { status: 403 });
    }

    // 3. Track Click (Non-blocking)
    context.waitUntil(recordClick(supabase, link, context.request));

    // 4. Geo Blocking
    const country = context.request.cf?.country || 'XX';
    if (link.block_indonesia && country === 'ID') {
        const domainUrl = link.domains?.url || 'https://google.com';
        // Add protocol if missing
        const redirectUrl = domainUrl.startsWith('http') ? domainUrl : `https://${domainUrl}`;
        return Response.redirect(redirectUrl, 302);
    }

    // 5. Final Redirect
    let target = link.original_url;
    // Append query params from request to target
    if (url.search) {
        const targetUrl = new URL(target);
        const requestParams = new URL(context.request.url).searchParams;
        requestParams.forEach((value, key) => {
            targetUrl.searchParams.append(key, value);
        });
        target = targetUrl.toString();
    }

    return Response.redirect(target, 302);
}
