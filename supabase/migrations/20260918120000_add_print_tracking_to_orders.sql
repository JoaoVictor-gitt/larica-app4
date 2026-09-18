alter table public.orders
  add column if not exists printed_at timestamptz,
  add column if not exists print_count integer not null default 0,
  add column if not exists last_printed_at timestamptz;

create or replace function public.register_order_print(p_order_id uuid)
returns orders
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_order public.orders;
begin
  if not public.is_staff() then
    raise exception 'Usuário sem permissão';
  end if;

  update public.orders
  set
    printed_at = coalesce(printed_at, now()),
    last_printed_at = now(),
    print_count = print_count + 1
  where id = p_order_id
  returning * into v_order;

  if v_order.id is null then
    raise exception 'Pedido não encontrado';
  end if;

  return v_order;
end;
$function$;
