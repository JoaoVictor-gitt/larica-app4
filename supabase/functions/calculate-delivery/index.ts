// Rate limiting/anti-bot é requisito de produção e será aplicado antes do
// deploy público.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN");

/** null quando ALLOWED_ORIGIN não está configurado — quem chama decide falhar (nunca libera '*'). */
function construirCorsHeaders(): Record<string, string> | null {
  if (!ALLOWED_ORIGIN) return null;
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

Deno.serve(async (req) => {
  const corsHeaders = construirCorsHeaders();

  // Sem ALLOWED_ORIGIN configurado: falha segura, sem processar nada — nem
  // headers CORS pra devolver. Mesmo padrão fail-closed de create-staff-user.
  if (!corsHeaders) {
    return new Response(
      JSON.stringify({ error: "Configuração de CORS ausente no servidor." }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // Origin presente precisa bater exatamente com ALLOWED_ORIGIN — nunca
  // reflete outro valor. Requests sem header Origin (server-to-server)
  // não são rejeitadas por isso só.
  const requestOrigin = req.headers.get("Origin");
  if (requestOrigin && requestOrigin !== ALLOWED_ORIGIN) {
    return new Response(
      JSON.stringify({ error: "Origem não permitida." }),
      {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  // Preflight CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
    });
  }

  try {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({
          error: "Método não permitido.",
        }),
        {
          status: 405,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    // =========================================================
    // SECRETS
    // =========================================================

    const googleApiKey = Deno.env.get("GOOGLE_MAPS_API_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceRoleKey = Deno.env.get(
      "SUPABASE_SERVICE_ROLE_KEY",
    );

    if (!googleApiKey) {
      throw new Error(
        "GOOGLE_MAPS_API_KEY não configurada.",
      );
    }

    if (!supabaseUrl) {
      throw new Error(
        "SUPABASE_URL não configurada.",
      );
    }

    if (!supabaseServiceRoleKey) {
      throw new Error(
        "SUPABASE_SERVICE_ROLE_KEY não configurada.",
      );
    }

    // Cliente administrativo usado SOMENTE dentro da Edge Function.
    // Essa chave nunca é enviada ao navegador.
    const supabaseAdmin = createClient(
      supabaseUrl,
      supabaseServiceRoleKey,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      },
    );

    // =========================================================
    // LIMITE DE BODY
    // Content-Length nem sempre está presente (ex.: chunked) — quando
    // ausente, os limites por campo abaixo (VALIDAÇÃO) já cobrem payloads
    // grandes, já que só 4 campos são lidos.
    // =========================================================

    const MAX_BODY_BYTES = 8 * 1024;
    const contentLength = req.headers.get("Content-Length");
    if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
      return new Response(
        JSON.stringify({
          error: "Corpo da requisição excede o limite permitido.",
        }),
        {
          status: 413,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    // =========================================================
    // BODY
    // Só estas 4 propriedades são lidas do payload — qualquer outra,
    // se enviada, é ignorada.
    // =========================================================

    const body = await req.json();

    const {
      eircode,
      address_line_1,
      address_line_2,
      area,
    } = body;

    const normalizedEircode =
      typeof eircode === "string"
        ? eircode.trim()
        : "";

    const normalizedAddressLine1 =
      typeof address_line_1 === "string"
        ? address_line_1.trim()
        : "";

    const normalizedAddressLine2 =
      typeof address_line_2 === "string" &&
      address_line_2.trim()
        ? address_line_2.trim()
        : null;

    const normalizedArea =
      typeof area === "string" && area.trim()
        ? area.trim()
        : null;

    // =========================================================
    // VALIDAÇÃO
    // =========================================================

    if (!normalizedEircode || normalizedEircode.length > 16) {
      return new Response(
        JSON.stringify({
          error: "Eircode é obrigatório.",
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    if (!normalizedAddressLine1 || normalizedAddressLine1.length > 200) {
      return new Response(
        JSON.stringify({
          error: "Endereço é obrigatório.",
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    if (normalizedAddressLine2 && normalizedAddressLine2.length > 200) {
      return new Response(
        JSON.stringify({
          error: "Complemento de endereço inválido.",
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    if (normalizedArea && normalizedArea.length > 100) {
      return new Response(
        JSON.stringify({
          error: "Área/bairro inválido.",
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    // =========================================================
    // DESTINO
    // =========================================================

    const destinationParts = [
      normalizedAddressLine1,
      normalizedAddressLine2,
      normalizedArea,
      normalizedEircode,
      "Dublin",
      "Ireland",
    ]
      .filter(Boolean)
      .map((value) => String(value).trim());

    const destinationAddress =
      destinationParts.join(", ");

    // =========================================================
    // CONFIGURAÇÃO DE ENTREGA (public.business_settings)
    // Nunca confia em valores vindos do navegador — origem, taxas e
    // distância máxima vêm exclusivamente do banco, via supabaseAdmin
    // (service_role). Roda ANTES da chamada ao Google pra não gastar a
    // requisição quando a entrega estiver desativada ou a config inválida.
    // =========================================================

    const {
      data: settings,
      error: settingsError,
    } = await supabaseAdmin
      .from("business_settings")
      .select(
        "delivery_enabled, delivery_minimum_fee, delivery_minimum_distance_km, delivery_price_per_km, delivery_max_distance_km, delivery_origin_lat, delivery_origin_lng",
      )
      .eq("id", 1)
      .single();

    if (settingsError || !settings) {
      console.error(
        "Erro ao ler business_settings:",
        settingsError,
      );

      return new Response(
        JSON.stringify({
          error:
            "Configuração de entrega indisponível. Tente novamente.",
        }),
        {
          status: 500,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    if (!settings.delivery_enabled) {
      return new Response(
        JSON.stringify({
          error: "Entrega desativada no momento.",
        }),
        {
          status: 422,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    const originLat = Number(settings.delivery_origin_lat);
    const originLng = Number(settings.delivery_origin_lng);
    const minimumFee = Number(settings.delivery_minimum_fee);
    const minimumDistanceKm = Number(
      settings.delivery_minimum_distance_km,
    );
    const pricePerKm = Number(settings.delivery_price_per_km);
    const maxDistanceKm =
      settings.delivery_max_distance_km === null ||
      settings.delivery_max_distance_km === undefined
        ? null
        : Number(settings.delivery_max_distance_km);

    const configIsValid =
      Number.isFinite(originLat) &&
      originLat >= -90 &&
      originLat <= 90 &&
      Number.isFinite(originLng) &&
      originLng >= -180 &&
      originLng <= 180 &&
      Number.isFinite(minimumFee) &&
      minimumFee >= 0 &&
      Number.isFinite(minimumDistanceKm) &&
      minimumDistanceKm >= 0 &&
      Number.isFinite(pricePerKm) &&
      pricePerKm >= 0 &&
      (maxDistanceKm === null ||
        (Number.isFinite(maxDistanceKm) &&
          maxDistanceKm >= minimumDistanceKm));

    if (!configIsValid) {
      console.error(
        "business_settings com valores fora da faixa esperada:",
        settings,
      );

      return new Response(
        JSON.stringify({
          error:
            "Configuração de entrega inválida. Tente novamente.",
        }),
        {
          status: 500,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    // =========================================================
    // GOOGLE ROUTES API
    // =========================================================

    const googleResponse = await fetch(
      "https://routes.googleapis.com/directions/v2:computeRoutes",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": googleApiKey,
          "X-Goog-FieldMask":
            "routes.distanceMeters,routes.duration",
        },

        body: JSON.stringify({
          origin: {
            location: {
              latLng: {
                latitude: originLat,
                longitude: originLng,
              },
            },
          },

          destination: {
            address: destinationAddress,
          },

          travelMode: "BICYCLE",

          regionCode: "ie",
          languageCode: "en-IE",
          units: "METRIC",

          computeAlternativeRoutes: false,
        }),
      },
    );

    const googleData =
      await googleResponse.json();

    if (!googleResponse.ok) {
      console.error(
        "Google Routes API error:",
        googleData,
      );

      return new Response(
        JSON.stringify({
          error:
            "Não foi possível calcular a rota de entrega.",
        }),
        {
          status: 502,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    const route = googleData?.routes?.[0];

    if (
      !route ||
      typeof route.distanceMeters !== "number"
    ) {
      return new Response(
        JSON.stringify({
          error:
            "Não foi encontrada uma rota de bicicleta para este endereço.",
        }),
        {
          status: 404,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    // =========================================================
    // CÁLCULO
    // =========================================================

    const distanceKm =
      route.distanceMeters / 1000;

    const roundedDistanceKm =
      Number(distanceKm.toFixed(2));

    // Distância máxima só pode ser checada depois da distância REAL do Google.
    if (
      maxDistanceKm !== null &&
      distanceKm > maxDistanceKm
    ) {
      return new Response(
        JSON.stringify({
          error: "Endereço fora da área de entrega.",
        }),
        {
          status: 422,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    // Até minimumDistanceKm: taxa fixa minimumFee. Acima disso: pricePerKm sobre a
    // distância TOTAL (nunca minimumFee + excedente). Valores vêm de business_settings.
    const deliveryFee =
      distanceKm <= minimumDistanceKm
        ? Number(minimumFee.toFixed(2))
        : Number((distanceKm * pricePerKm).toFixed(2));

    // =========================================================
    // CRIA COTAÇÃO SEGURA NO SUPABASE
    // =========================================================

    const expiresAt =
      new Date(
        Date.now() + 30 * 60 * 1000,
      ).toISOString();

    const {
      data: quote,
      error: quoteError,
    } = await supabaseAdmin
      .from("delivery_quotes")
      .insert({
        eircode: normalizedEircode,

        address_line_1:
          normalizedAddressLine1,

        address_line_2:
          normalizedAddressLine2,

        area:
          normalizedArea,

        distance_km:
          roundedDistanceKm,

        delivery_fee:
          deliveryFee,

        travel_mode:
          "BICYCLE",

        expires_at:
          expiresAt,
      })
      .select("id")
      .single();

    if (quoteError || !quote?.id) {
      console.error(
        "Erro ao criar delivery_quote:",
        quoteError,
      );

      return new Response(
        JSON.stringify({
          success: false,
          error:
            "Não foi possível registrar a cotação de entrega.",
        }),
        {
          status: 500,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    // =========================================================
    // RETORNO
    // =========================================================

    return new Response(
      JSON.stringify({
        success: true,

        // NOVO:
        // esse ID será enviado posteriormente para
        // create_customer_order
        quote_id: quote.id,

        origin: {
          latitude: originLat,
          longitude: originLng,
        },

        destination:
          destinationAddress,

        travel_mode:
          "BICYCLE",

        distance_meters:
          route.distanceMeters,

        distance_km:
          roundedDistanceKm,

        duration:
          route.duration ?? null,

        delivery_fee:
          deliveryFee,

        currency:
          "EUR",

        rate_per_km:
          pricePerKm,

        // Informativo — não é usado pelo frontend pra recalcular nada.
        minimum_fee: minimumFee,
        minimum_distance_km: minimumDistanceKm,
        max_distance_km: maxDistanceKm,

        expires_at:
          expiresAt,

        bicycle_route_warning:
          "A rota de bicicleta é uma estimativa e pode não refletir todas as condições ou infraestruturas cicláveis locais.",
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    console.error(
      "calculate-delivery error:",
      error,
    );

    return new Response(
      JSON.stringify({
        error:
          "Erro interno ao calcular a entrega.",
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  }
});
