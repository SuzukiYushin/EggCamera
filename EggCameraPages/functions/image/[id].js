const R2_BASE = 'https://pub-c35d182b845942f3b26d0ed65d668e0d.r2.dev';

export async function onRequestGet(context) {
    const id  = context.params.id;
    const res = await fetch(`${R2_BASE}/${id}`);

    if (!res.ok) {
        return new Response('Not found', { status: 404 });
    }

    return new Response(res.body, {
        headers: {
            'Content-Type':  'image/jpeg',
            'Cache-Control': 'private, max-age=259200',
        },
    });
}
