# -*- coding: utf-8 -*-
import asyncio
import time
import random
import logging
import os

from aiogram import Bot, Dispatcher, F
from aiogram.filters import CommandStart
from aiogram.types import (
    Message, CallbackQuery,
    InlineKeyboardMarkup, InlineKeyboardButton,
)
from aiogram.client.default import DefaultBotProperties

import firebase_admin
from firebase_admin import credentials, db as fbdb

# ================= НАСТРОЙКИ =================
BOT_TOKEN      = "8427043899:AAE-opYcKZWE-eO347tZRrOFqImOxSSOFnc"
ADMIN_ID       = 8295645690
FIREBASE_CRED  = "serviceAccountKey.json"
FIREBASE_URL   = "https://game-cd07d-default-rtdb.firebaseio.com"

CARD_NUMBER = "2204 1201 4472 3133"
BANK_NAME   = "ЮMoney"
BANK_NUMBER = "4100118891507332"

# Пакеты звёзд
PACKS = {
    "p1": {"stars": 100,   "rub": 99},
    "p2": {"stars": 250,   "rub": 249},
    "p3": {"stars": 500,   "rub": 449},
    "p4": {"stars": 1000,  "rub": 849},
    "p5": {"stars": 2500,  "rub": 1990},
    "p6": {"stars": 5000,  "rub": 3790},
    "p7": {"stars": 10000, "rub": 6990},
}

# Премиум-подписки
PREMIUM_PLANS = {
    "pm_month":   {"plan": "month",   "rub": 199,  "days": 30,  "title": "Премиум · 1 месяц"},
    "pm_quarter": {"plan": "quarter", "rub": 499,  "days": 90,  "title": "Премиум · 3 месяца"},
    "pm_year":    {"plan": "year",    "rub": 1490, "days": 365, "title": "Премиум · 1 год"},
}

RATE_LIMIT_MS  = 5 * 60 * 1000      # анти-спам 5 минут
PENDING_TTL_MS = 24 * 3600 * 1000   # заявка живёт 24 часа
# ==============================================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
)

if not firebase_admin._apps:
    cred = credentials.Certificate(FIREBASE_CRED)
    firebase_admin.initialize_app(cred, {"databaseURL": FIREBASE_URL})

if not BOT_TOKEN:
    raise RuntimeError("BOT_TOKEN is not set. Put your Telegram bot token in the environment.")

bot = Bot(token=BOT_TOKEN, default=DefaultBotProperties(parse_mode="HTML"))
dp = Dispatcher()


# ---------- Firebase helpers ----------
def fb_get(path):
    return fbdb.reference(path).get()

def fb_set(path, value):
    fbdb.reference(path).set(value)

def fb_update(path, value):
    fbdb.reference(path).update(value)

def fb_increment(path, delta):
    def _tx(cur):
        return (cur or 0) + delta
    return fbdb.reference(path).transaction(_tx)

async def fb_get_async(p):
    return await asyncio.get_event_loop().run_in_executor(None, fb_get, p)

async def fb_set_async(p, v):
    return await asyncio.get_event_loop().run_in_executor(None, fb_set, p, v)

async def fb_update_async(p, v):
    return await asyncio.get_event_loop().run_in_executor(None, fb_update, p, v)

async def fb_increment_async(p, d):
    return await asyncio.get_event_loop().run_in_executor(None, fb_increment, p, d)


# ---------- Утилиты ----------
def is_admin(uid):
    return uid == ADMIN_ID

def gen_code(uid):
    tail = uid.replace("-", "")[-4:] if uid else "0000"
    return f"F{tail}{random.randint(1000, 9999)}"

def now_ms():
    return int(time.time() * 1000)

def fmt_wait(sec):
    m, s = sec // 60, sec % 60
    return f"{m} мин {s} сек" if m else f"{s} сек"

def fmt_date(ms):
    return time.strftime("%d.%m.%Y %H:%M", time.localtime(ms / 1000))


# ================= Premium / RUB payment =================
@dp.message(F.text == "/paysupport")
async def cmd_paysupport(message: Message):
    await message.answer(
        "🛟 <b>Поддержка платежей Flux</b>\n\n"
        "Если оплата прошла, но Premium не активировался, отправьте сюда ваш Telegram ID и время платежа."
    )

@dp.message(F.text == "/terms")
async def cmd_terms(message: Message):
    await message.answer(
        "📄 <b>Условия покупки Flux Premium</b>\n\n"
        "Premium оплачивается в рублях банковским переводом по реквизитам, которые показывает бот. После перевода отправьте скриншот в чат. Администратор проверит платеж и активирует Premium на оплаченный срок.\n\n"
        "Если возникла проблема с покупкой, используйте /paysupport."
    )

# ================= /start =================
@dp.message(CommandStart())
async def start_handler(message: Message):
    args = message.text.split(maxsplit=1)
    payload = args[1] if len(args) > 1 else ""

    if "_" not in payload:
        await message.answer(
            "👋 Привет! Это бот оплаты Flux.\n\n"
            "💰 <b>Звёзды</b> — открой <b>Магазин → ⭐ Звёзды</b>\n"
            "👑 <b>Премиум</b> — открой <b>Магазин → 👑 Премиум</b>"
        )
        return

    uid, item_id = payload.split("_", 1)

    # Определяем тип покупки
    is_premium = item_id.startswith("pm_")
    if is_premium:
        item = PREMIUM_PLANS.get(item_id)
    else:
        item = PACKS.get(item_id)

    if not item:
        await message.answer("⚠️ Неизвестный товар. Открой оплату заново из приложения.")
        return

    # Premium оплачивается вручную в рублях через реквизиты ниже.
    user_data = await fb_get_async(f"users/{uid}")
    if not user_data or not user_data.get("name"):
        await message.answer(
            f"⚠️ Пользователь не найден.\n\nUID: <code>{uid}</code>\n"
            "Войди в приложение и попробуй снова."
        )
        return

    tg_user_id = message.from_user.id
    now = now_ms()

    # === Анти-спам ===
    old_pays = await fb_get_async(f"payments/{uid}") or {}
    fresh_pending = None
    for old_rid, old_p in old_pays.items():
        if old_p.get("status") == "pending":
            age = now - old_p.get("createdAt", 0)
            if age < RATE_LIMIT_MS:
                fresh_pending = {"rid": old_rid, "pay": old_p, "age_ms": age}
                break

    if fresh_pending:
        wait_sec = max(1, int((RATE_LIMIT_MS - fresh_pending["age_ms"]) / 1000))
        p = fresh_pending["pay"]
        item_label = p.get("itemLabel", f"{p.get('stars',0)} ⭐")
        await message.answer(
            f"⏳ <b>У тебя уже есть активная заявка</b>\n\n"
            f"💳 {item_label} · <b>{p['rub']} ₽</b>\n"
            f"🔑 Код: <code>{p['code']}</code>\n\n"
            f"📸 Отправь скриншот перевода.\n\n"
            f"⏱ Новая заявка через <b>{fmt_wait(wait_sec)}</b>."
        )
        return

    # === Отменяем старые pending ===
    for old_rid, old_p in old_pays.items():
        if old_p.get("status") == "pending":
            await fb_update_async(f"payments/{uid}/{old_rid}", {"status": "cancelled"})

    # === Создаём новую заявку ===
    code = gen_code(uid)
    req_data = {
        "userId": uid,
        "tgUserId": tg_user_id,
        "userName": user_data.get("name", ""),
        "username": user_data.get("username", ""),
        "packId": item_id,
        "type": "premium" if is_premium else "stars",
        "rub": item["rub"],
        "code": code,
        "status": "pending",
        "credited": False,
        "source": "telegram",
        "createdAt": now,
    }
    if is_premium:
        req_data["plan"] = item["plan"]
        req_data["days"] = item["days"]
        req_data["itemLabel"] = f"👑 {item['title']}"
    else:
        req_data["stars"] = item["stars"]
        req_data["itemLabel"] = f"{item['stars']} ⭐"

    ref = fbdb.reference(f"payments/{uid}").push(req_data)
    req_id = ref.key

    if is_premium:
        title_line = f"👑 <b>{item['title']}</b>"
    else:
        title_line = f"💳 <b>Оплата {item['stars']} ⭐</b>"

    await message.answer(
        f"{title_line}\n\n"
        f"К оплате: <b>{item['rub']} ₽</b>\n"
        f"Код платежа: <code>{code}</code>\n\n"
        f"<b>Реквизиты:</b>\n"
        f"💳 Карта: <code>{CARD_NUMBER}</code>\n"
        f"📱 {BANK_NAME}: <code>{BANK_NUMBER}</code>\n\n"
        f"⚠️ Укажи код <code>{code}</code> в комментарии к переводу.\n\n"
        f"📸 После оплаты отправь <b>скриншот</b> в этот чат.\n\n"
        f"⏱ <i>Следующая заявка — через 5 минут.</i>"
    )
    logging.info(f"Заявка {req_id} · uid={uid} · {'premium' if is_premium else 'stars'}")


# ================= Приём скриншота =================
@dp.message(F.photo)
async def handle_screenshot(message: Message):
    if is_admin(message.from_user.id):
        await message.answer("Это админ-аккаунт. Скриншоты — от пользователей.")
        return

    tg_user_id = message.from_user.id
    logging.info(f"Скриншот от tg={tg_user_id}")

    all_pays = await fb_get_async("payments") or {}
    now = now_ms()
    found = None

    for uid, reqs in all_pays.items():
        for rid, p in (reqs or {}).items():
            if p.get("status") != "pending":
                continue
            if p.get("tgUserId") != tg_user_id:
                continue
            if now - p.get("createdAt", 0) > PENDING_TTL_MS:
                continue
            found = {"uid": uid, "rid": rid, "pay": p}
            break
        if found:
            break

    if not found:
        await message.answer(
            "⚠️ Не нашёл активную заявку.\n\n"
            "Открой оплату заново: <b>Магазин</b> в приложении."
        )
        return

    file_id = message.photo[-1].file_id
    await fb_update_async(f"payments/{found['uid']}/{found['rid']}", {
        "status": "awaiting",
        "proofImageFileId": file_id,
        "paidAt": now_ms(),
    })

    pay = found["pay"]
    type_icon = "👑" if pay.get("type") == "premium" else "⭐"
    item_label = pay.get("itemLabel", "")

    try:
        await bot.send_photo(
            ADMIN_ID,
            file_id,
            caption=(
                f"🟡 <b>Новая заявка</b>\n\n"
                f"👤 {pay.get('userName','—')} "
                f"{('@'+pay.get('username')) if pay.get('username') else ''}\n"
                f"🆔 UID: <code>{found['uid']}</code>\n"
                f"📱 TG: <code>{tg_user_id}</code>\n"
                f"{type_icon} {item_label}\n"
                f"💰 {pay['rub']} ₽\n"
                f"🔑 Код: <code>{pay['code']}</code>"
            ),
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[[
                InlineKeyboardButton(text="✅ Подтвердить",
                    callback_data=f"confirm:{found['uid']}:{found['rid']}"),
                InlineKeyboardButton(text="❌ Отклонить",
                    callback_data=f"reject:{found['uid']}:{found['rid']}"),
            ]]),
        )
    except Exception as e:
        logging.exception(f"Ошибка отправки админу: {e}")

    await message.answer(
        "✅ Скриншот получен и отправлен на проверку."
    )


# ================= Подтверждение =================
@dp.callback_query(F.data.startswith("confirm:") | F.data.startswith("confirm_"))
async def cb_confirm(callback: CallbackQuery):
    """Надёжное подтверждение заявки админом.
    Поддерживает старые callback_data confirm_UID_RID и новые confirm:UID:RID.
    Все ошибки показываются админу, а не теряются в фоне.
    """
    if not is_admin(callback.from_user.id):
        await callback.answer("Нет доступа", show_alert=True)
        return

    data = callback.data or ""
    parts = data.split(":", 2) if data.startswith("confirm:") else data.split("_", 2)
    if len(parts) != 3 or not parts[1] or not parts[2]:
        await callback.answer("Некорректная заявка", show_alert=True)
        return
    _, uid, rid = parts

    try:
        pay = await fb_get_async(f"payments/{uid}/{rid}")
        if not pay:
            await callback.answer("Заявка не найдена в Firebase", show_alert=True)
            return
        if pay.get("status") == "confirmed":
            await callback.answer("Уже подтверждена", show_alert=True)
            return
        if pay.get("status") == "rejected":
            await callback.answer("Эта заявка уже отклонена", show_alert=True)
            return

        # Сначала сообщаем Telegram, что callback принят.
        await callback.answer("⏳ Подтверждаю оплату…")

        kind = pay.get("type", "stars")
        now = now_ms()
        updates = {
            f"payments/{uid}/{rid}/status": "confirmed",
            f"payments/{uid}/{rid}/credited": True,
            f"payments/{uid}/{rid}/confirmedAt": now,
            f"payments/{uid}/{rid}/confirmedBy": callback.from_user.id,
        }

        if kind == "premium":
            plan_id = pay.get("packId")
            plan = PREMIUM_PLANS.get(plan_id)
            if not plan:
                raise RuntimeError(f"Неизвестный Premium-план: {plan_id}")

            user_prem = await fb_get_async(f"users/{uid}/premium") or {}
            cur_exp = int(user_prem.get("expiresAt") or 0)
            cur_active = bool(user_prem.get("active")) and cur_exp > now

            base = cur_exp if cur_active else now
            new_exp = base + int(plan["days"]) * 86400000
            since = int(user_prem.get("since") or now) if cur_active else now
            action = "продлён" if cur_active else "активирован"

            # Один multi-location update: Premium и заявка подтверждаются атомарно.
            updates.update({
                f"users/{uid}/premium/active": True,
                f"users/{uid}/premium/plan": plan["plan"],
                f"users/{uid}/premium/expiresAt": new_exp,
                f"users/{uid}/premium/since": since,
                f"users/{uid}/premium/rub": int(plan["rub"]),
                f"users/{uid}/premium/lastPaymentId": rid,
                f"users/{uid}/premium/lastPaymentAt": now,
                f"users/{uid}/premium/lastPaymentRub": int(plan["rub"]),
            })

            await asyncio.get_event_loop().run_in_executor(
                None, lambda: fbdb.reference("/").update(updates)
            )

            result_text = (
                f"\n\n✅ <b>ПОДТВЕРЖДЕНО</b>\n"
                f"👑 Premium {action}\n"
                f"💰 {plan['rub']} ₽\n"
                f"📅 До: <b>{fmt_date(new_exp)}</b>"
            )
            user_msg = (
                f"🎉 <b>Оплата подтверждена!</b>\n\n"
                f"👑 Premium {action}\n"
                f"💰 Оплачено: <b>{plan['rub']} ₽</b>\n"
                f"📅 Действует до: <b>{fmt_date(new_exp)}</b>\n\n"
                f"✨ Premium-функции уже активны. Открой Flux."
            )
        else:
            stars = int(pay.get("stars") or 0)
            if stars <= 0:
                raise RuntimeError("В заявке отсутствует количество Stars")
            new_balance = await fb_increment_async(f"users/{uid}/stars", stars)
            await asyncio.get_event_loop().run_in_executor(
                None, lambda: fbdb.reference("/").update(updates)
            )
            result_text = (
                f"\n\n✅ <b>ПОДТВЕРЖДЕНО</b>\n"
                f"⭐ +{stars} · баланс: <b>{new_balance}</b> ⭐"
            )
            user_msg = (
                f"🎉 <b>Оплата подтверждена!</b>\n\n"
                f"⭐ Зачислено: <b>{stars}</b>\n"
                f"💰 Баланс: <b>{new_balance}</b> ⭐"
            )

        # Убираем кнопки и добавляем результат в карточку администратора.
        if callback.message:
            try:
                if callback.message.photo:
                    await callback.message.edit_caption(
                        caption=(callback.message.caption or "") + result_text,
                        reply_markup=None,
                    )
                else:
                    await callback.message.edit_text(
                        text=(callback.message.text or "") + result_text,
                        reply_markup=None,
                    )
            except Exception:
                try:
                    await callback.message.edit_reply_markup(reply_markup=None)
                except Exception:
                    pass

        tg_uid = pay.get("tgUserId")
        if tg_uid:
            try:
                await bot.send_message(tg_uid, user_msg)
            except Exception:
                logging.exception("Не удалось уведомить пользователя %s", tg_uid)

    except Exception as e:
        logging.exception("Ошибка подтверждения payments/%s/%s", uid, rid)
        try:
            await callback.answer(f"Ошибка: {str(e)[:180]}", show_alert=True)
        except Exception:
            pass


# ================= Отклонение =================
@dp.callback_query(F.data.startswith("reject:"))
@dp.callback_query(F.data.startswith("reject_"))
async def cb_reject(callback: CallbackQuery):
    if not is_admin(callback.from_user.id):
        await callback.answer("Нет доступа", show_alert=True)
        return

    data = callback.data or ""
    if data.startswith("reject:"):
        parts = data.split(":", 2)
    else:
        parts = data.split("_", 2)
    if len(parts) != 3:
        await callback.answer("Ошибка данных", show_alert=True)
        return
    _, uid, rid = parts

    try:
        pay = await fb_get_async(f"payments/{uid}/{rid}") or {}
        if not pay:
            await callback.answer("Заявка не найдена", show_alert=True)
            return
        if pay.get("status") == "rejected":
            await callback.answer("Уже отклонена", show_alert=True)
            return
        await callback.answer("⏳ Отклоняю…")
    except Exception:
        logging.exception("Ошибка чтения заявки %s/%s", uid, rid)
        await callback.answer("Ошибка Firebase", show_alert=True)
        return

    await fb_update_async(f"payments/{uid}/{rid}", {
        "status": "rejected",
        "rejectedAt": now_ms(),
        "reason": "Отклонено администратором",
    })

    try:
        await callback.message.edit_caption(
            caption=(callback.message.caption or "") + "\n\n❌ <b>Отклонено</b>",
            reply_markup=None,
        )
    except Exception:
        try:
            await callback.message.edit_reply_markup(reply_markup=None)
        except Exception:
            pass

    tg_uid = pay.get("tgUserId")
    if tg_uid:
        try:
            await bot.send_message(
                tg_uid,
                "❌ Ваша заявка отклонена. Если это ошибка — напишите администратору."
            )
        except Exception:
            pass


# ================= /stats =================
@dp.message(F.text == "/stats")
async def cmd_stats(message: Message):
    if not is_admin(message.from_user.id):
        return

    def _count():
        all_pays = fbdb.reference("payments").get() or {}
        s_pend = s_conf = s_rej = s_can = 0
        p_pend = p_conf = 0
        for reqs in all_pays.values():
            for p in (reqs or {}).values():
                s = p.get("status")
                is_prem = p.get("type") == "premium"
                if s in ("pending", "awaiting"):
                    s_pend += 1
                    if is_prem: p_pend += 1
                elif s == "confirmed":
                    s_conf += 1
                    if is_prem: p_conf += 1
                elif s == "rejected":
                    s_rej += 1
                elif s == "cancelled":
                    s_can += 1
        return s_pend, s_conf, s_rej, s_can, p_pend, p_conf

    sp, sc, sr, sca, pp, pc = await asyncio.get_event_loop().run_in_executor(None, _count)
    await message.answer(
        f"📊 <b>Статистика</b>\n\n"
        f"🟡 В ожидании: {sp} (из них 👑 {pp})\n"
        f"✅ Подтверждено: {sc} (из них 👑 {pc})\n"
        f"❌ Отклонено: {sr}\n"
        f"⚫ Отменено: {sca}"
    )


# ================= /cleanup =================
@dp.message(F.text == "/cleanup")
async def cmd_cleanup(message: Message):
    if not is_admin(message.from_user.id):
        return

    def _clean():
        all_pays = fbdb.reference("payments").get() or {}
        now = int(time.time() * 1000)
        removed = 0
        for uid, reqs in all_pays.items():
            for rid, p in (reqs or {}).items():
                if p.get("status") == "pending" and now - p.get("createdAt", 0) > RATE_LIMIT_MS:
                    fbdb.reference(f"payments/{uid}/{rid}").update({"status": "cancelled"})
                    removed += 1
        return removed

    removed = await asyncio.get_event_loop().run_in_executor(None, _clean)
    await message.answer(f"🧹 Отменено зависших заявок: <b>{removed}</b>")


# ================= Запуск =================
async def main():
    logging.info("Бот запущен")
    await bot.delete_webhook(drop_pending_updates=True)
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())