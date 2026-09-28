// Read-only preflight for a copied jbhh-demo-v1 JSON value. This module has no storage or UI entry point.
import { createHash } from 'node:crypto';
import { DEMO_STATE_KEY } from './persistence.js';
import { validateDemoState, migrateStartupState, migrateDemoState, normalizeDemoUser } from './migrations.js';
import { PAYMENT_METHODS } from './sales.js';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const addIssue = (items, code, path, message) => items.push({ code, path, message });
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && /(?:Z|[+-]\d{2}:\d{2})$/.test(value);

function finish(result) {
  result.status = result.errors.length ? 'error' : result.ambiguities.length ? 'ambiguous' : 'ok';
  return result;
}

function checkPreserved(source, migrated, field, path, errors) {
  const before = source?.[field];
  const after = migrated?.[field];
  if (before == null && after != null) {
    addIssue(errors, 'HISTORICAL_FACT_INVENTED', `${path}.${field}`, '迁移生成了原文没有的历史事实');
  } else if (before != null && after !== before) {
    addIssue(errors, 'HISTORICAL_FACT_CHANGED', `${path}.${field}`, '迁移改变了原文已有的历史事实');
  }
}

function summarize(source, state, ambiguities, errors) {
  const summary = {
    orders: { count: state.orders.length, room: 0, retail: 0, records: [], unknownFacts: { names: 0, categories: 0, optionNames: 0, baseUnits: 0, prices: 0, baseQuantities: 0, giftReferences: 0 } },
    payments: { count: 0, knownAmountCents: 0, amountComplete: true, byChannel: [], missingIds: 0, missingOccurredAt: 0, creditRepaymentLinks: { count: 0, matched: 0 } },
    inventory: { balances: [], unestablished: 0, zero: 0, movements: { counted: 0, uncounted: 0, unknown: 0 }, byProduct: [] },
    rooms: { count: state.rooms.length, byStatus: [], activeLinks: 0 },
    operationKeys: Array.isArray(state.processed) ? state.processed.length : null
  };
  const orderIds = new Set();
  const paymentIds = new Set();
  const channels = new Map();
  const ordersById = new Map();

  for (const [index, order] of state.orders.entries()) {
    const path = `orders[${index}]`;
    const original = source.orders[index];
    if (!isObject(order)) {
      addIssue(errors, 'ORDER_INVALID', path, '订单不是对象');
      continue;
    }
    if (typeof order.id !== 'string' || !order.id || orderIds.has(order.id)) {
      addIssue(errors, 'ORDER_ID_INVALID', `${path}.id`, '订单编号缺失或重复');
    } else {
      orderIds.add(order.id);
      ordersById.set(order.id, order);
    }
    if (original.kind == null) {
      addIssue(ambiguities, 'ORDER_KIND_INFERRED', `${path}.kind`, '原文未记订单种类；现有迁移链按旧房单处理，须核对');
    }
    if (order.kind === 'retail') {
      summary.orders.retail++;
      if (order.room !== null) addIssue(errors, 'RETAIL_ROOM_INVALID', `${path}.room`, '零售单的房间必须明确为 null');
    } else if (order.kind === 'room') {
      summary.orders.room++;
      if (typeof order.room !== 'string' || !order.room) addIssue(errors, 'ROOM_ORDER_REFERENCE_INVALID', `${path}.room`, '房单缺少有效房号');
      if (order.packageNameSnapshot == null) {
        summary.orders.unknownFacts.names++;
        addIssue(ambiguities, 'PACKAGE_NAME_UNKNOWN', `${path}.packageNameSnapshot`, '历史套餐名称未知');
      }
      if (order.packagePriceCents == null) {
        summary.orders.unknownFacts.prices++;
        addIssue(ambiguities, 'PACKAGE_PRICE_UNKNOWN', `${path}.packagePriceCents`, '历史套餐成交价未知，不使用当前目录补造');
      }
    } else {
      addIssue(errors, 'ORDER_KIND_INVALID', `${path}.kind`, '订单种类不是 room 或 retail');
    }
    checkPreserved(original, order, 'packageNameSnapshot', path, errors);
    summary.orders.records.push({ id: order.id ?? null, kind: order.kind ?? null, room: order.room ?? null, status: order.status ?? null, saleLines: Array.isArray(order.sales) ? order.sales.length : null, payments: Array.isArray(order.payments) ? order.payments.length : null });

    if (!Array.isArray(original.payments)) {
      addIssue(ambiguities, 'PAYMENTS_MISSING_IN_SOURCE', `${path}.payments`, '原文没有付款数组，不能据迁移后的空数组断言未收款');
    }
    if (!Array.isArray(order.payments)) {
      addIssue(errors, 'PAYMENTS_INVALID', `${path}.payments`, '付款不是数组');
      continue;
    }
    for (const [paymentIndex, payment] of order.payments.entries()) {
      const paymentPath = `${path}.payments[${paymentIndex}]`;
      summary.payments.count++;
      if (!isObject(payment)) {
        summary.payments.amountComplete = false;
        addIssue(errors, 'PAYMENT_INVALID', paymentPath, '付款不是对象');
        continue;
      }
      const amountConflict = payment.amountCents != null && payment.amount != null && payment.amountCents !== payment.amount;
      if (amountConflict) addIssue(errors, 'PAYMENT_AMOUNT_CONFLICT', paymentPath, '付款金额的新旧字段互相矛盾');
      const amount = amountConflict ? null : payment.amountCents ?? payment.amount;
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        summary.payments.amountComplete = false;
        addIssue(errors, 'PAYMENT_AMOUNT_INVALID', `${paymentPath}.amount`, '付款金额不是正的安全整数分');
      } else {
        const next = summary.payments.knownAmountCents + amount;
        if (!Number.isSafeInteger(next)) {
          summary.payments.amountComplete = false;
          addIssue(errors, 'PAYMENT_TOTAL_OVERFLOW', paymentPath, '付款合计超出安全整数范围');
        } else {
          summary.payments.knownAmountCents = next;
        }
      }
      const channel = PAYMENT_METHODS.includes(payment.method) ? payment.method : '未知';
      if (channel === '未知') addIssue(ambiguities, 'PAYMENT_CHANNEL_UNKNOWN', `${paymentPath}.method`, '付款渠道未知，不能猜为现金或线上支付');
      const channelRow = channels.get(channel) || { method: channel, count: 0, knownAmountCents: 0 };
      channelRow.count++;
      if (Number.isSafeInteger(amount) && amount > 0) {
        const channelTotal = channelRow.knownAmountCents + amount;
        if (Number.isSafeInteger(channelTotal)) channelRow.knownAmountCents = channelTotal;
        else { summary.payments.amountComplete = false; addIssue(errors, 'PAYMENT_CHANNEL_TOTAL_OVERFLOW', paymentPath, '单渠道付款合计超出安全整数范围'); }
      }
      channels.set(channel, channelRow);
      if (payment.id == null || payment.id === '') {
        summary.payments.missingIds++;
      } else {
        const id = String(payment.id);
        if (paymentIds.has(id)) addIssue(errors, 'PAYMENT_ID_DUPLICATE', `${paymentPath}.id`, '付款编号重复');
        paymentIds.add(id);
      }
      if (payment.occurredAt == null) {
        summary.payments.missingOccurredAt++;
        if (!validTime(payment.time)) addIssue(errors, 'PAYMENT_TIME_UNKNOWN', paymentPath, '付款缺少可信可解析的发生时间');
      } else if (!validTime(payment.occurredAt)) {
        addIssue(errors, 'PAYMENT_TIME_INVALID', `${paymentPath}.occurredAt`, '资金发生时间缺少有效时区');
      }
    }

    if (!Array.isArray(order.sales)) {
      addIssue(errors, 'SALE_LINES_INVALID', `${path}.sales`, '销售行不是数组');
    } else {
      for (const [saleIndex, sale] of order.sales.entries()) {
        const salePath = `${path}.sales[${saleIndex}]`;
        const oldSale = original.sales?.[saleIndex];
        if (!isObject(sale)) {
          addIssue(errors, 'SALE_LINE_INVALID', salePath, '销售行不是对象');
          continue;
        }
        for (const field of ['productNameSnapshot', 'categorySnapshot', 'saleOptionNameSnapshot', 'pricePerSaleUnitCents', 'baseUnitSnapshot']) {
          checkPreserved(oldSale, sale, field, salePath, errors);
        }
        if (sale.productNameSnapshot == null) {
          summary.orders.unknownFacts.names++;
          addIssue(ambiguities, 'HISTORICAL_NAME_UNKNOWN', `${salePath}.productNameSnapshot`, '历史商品名称未知，不使用当前目录补造');
        }
        if (sale.categorySnapshot == null) {
          summary.orders.unknownFacts.categories++;
          addIssue(ambiguities, 'HISTORICAL_CATEGORY_UNKNOWN', `${salePath}.categorySnapshot`, '历史商品分类未知');
        }
        if (sale.baseUnitSnapshot == null) {
          summary.orders.unknownFacts.baseUnits++;
          addIssue(ambiguities, 'HISTORICAL_UNIT_UNKNOWN', `${salePath}.baseUnitSnapshot`, '历史商品基础单位未知');
        }
        if (sale.saleOptionNameSnapshot == null) {
          summary.orders.unknownFacts.optionNames++;
          addIssue(ambiguities, 'HISTORICAL_OPTION_UNKNOWN', `${salePath}.saleOptionNameSnapshot`, '历史销售规格名称未知');
        }
        if (sale.pricePerSaleUnitCents == null) {
          summary.orders.unknownFacts.prices++;
          addIssue(ambiguities, 'HISTORICAL_PRICE_UNKNOWN', `${salePath}.pricePerSaleUnitCents`, '历史规格单价未知，不使用当前目录补造');
        }
        if (sale.pricePerSaleUnitCents != null && (!Number.isSafeInteger(sale.pricePerSaleUnitCents) || sale.pricePerSaleUnitCents < 0)) {
          addIssue(errors, 'SALE_PRICE_INVALID', `${salePath}.pricePerSaleUnitCents`, '历史规格单价不是有效整数分');
        }
        for (const field of ['saleQuantity', 'baseQuantityPerSaleUnit', 'totalBaseQuantity']) {
          if (sale[field] != null && (!Number.isSafeInteger(sale[field]) || sale[field] <= 0)) {
            addIssue(errors, 'SALE_QUANTITY_INVALID', `${salePath}.${field}`, '销售及基础数量必须是正的安全整数');
          }
        }
        if (sale.saleQuantity == null || sale.totalBaseQuantity == null || sale.baseQuantityPerSaleUnit == null) {
          summary.orders.unknownFacts.baseQuantities++;
          addIssue(ambiguities, 'HISTORICAL_BASE_QUANTITY_UNKNOWN', salePath, '历史销售数量、基础数量或每规格基础数量未知');
        } else if (Number.isSafeInteger(sale.saleQuantity) && Number.isSafeInteger(sale.baseQuantityPerSaleUnit) && Number.isSafeInteger(sale.totalBaseQuantity) && sale.saleQuantity * sale.baseQuantityPerSaleUnit !== sale.totalBaseQuantity) {
          addIssue(errors, 'SALE_BASE_QUANTITY_MISMATCH', salePath, '销售数量与基础数量快照不一致');
        }
        if (sale.amountCents != null && sale.amount != null && sale.amountCents !== sale.amount) {
          addIssue(errors, 'SALE_AMOUNT_CONFLICT', salePath, '销售行金额的新旧字段互相矛盾');
        }
        const saleAmount = sale.amountCents ?? sale.amount;
        if (saleAmount == null) addIssue(ambiguities, 'SALE_AMOUNT_UNKNOWN', salePath, '历史销售行成交金额未知');
        else if (!Number.isSafeInteger(saleAmount) || saleAmount < 0) addIssue(errors, 'SALE_AMOUNT_INVALID', salePath, '销售行金额不是有效整数分');
      }
    }
    if (!Array.isArray(order.resolvedComponents)) {
      addIssue(errors, 'COMPONENTS_INVALID', `${path}.resolvedComponents`, '套餐实际组成不是数组');
    } else {
      for (const [componentIndex, component] of order.resolvedComponents.entries()) {
        const componentPath = `${path}.resolvedComponents[${componentIndex}]`;
        if (!isObject(component)) {
          addIssue(errors, 'COMPONENT_INVALID', componentPath, '套餐组成不是对象');
          continue;
        }
        if (component.productNameSnapshot == null) {
          summary.orders.unknownFacts.names++;
          addIssue(ambiguities, 'COMPONENT_NAME_UNKNOWN', `${componentPath}.productNameSnapshot`, '历史套餐实际商品名称未知');
        }
        if (component.totalBaseQuantity == null || component.baseUnitSnapshot == null) {
          summary.orders.unknownFacts.baseQuantities++;
          addIssue(ambiguities, 'COMPONENT_BASE_QUANTITY_UNKNOWN', componentPath, '历史套餐实际基础数量或单位未知');
        }
      }
    }
    if (!Array.isArray(order.bonusGifts)) {
      addIssue(errors, 'GIFTS_INVALID', `${path}.bonusGifts`, '赠酒记录不是数组');
    } else for (const [giftIndex, gift] of order.bonusGifts.entries()) {
      const giftPath = `${path}.bonusGifts[${giftIndex}]`;
      if (!isObject(gift)) {
        addIssue(errors, 'GIFT_INVALID', giftPath, '赠酒记录不是对象');
        continue;
      }
      checkPreserved(original.bonusGifts?.[giftIndex], gift, 'referenceValueCents', giftPath, errors);
      if (gift.referenceValueCents == null) {
        summary.orders.unknownFacts.giftReferences++;
        addIssue(ambiguities, 'HISTORICAL_GIFT_REFERENCE_UNKNOWN', `${giftPath}.referenceValueCents`, '赠酒参考值未知，不按现价补造');
      }
    }

    const repayments = order.credit?.repayments || [];
    if (!Array.isArray(repayments)) {
      addIssue(errors, 'CREDIT_REPAYMENTS_INVALID', `${path}.credit.repayments`, '挂账回款记录不是数组');
      continue;
    }
    for (const [repaymentIndex, repayment] of repayments.entries()) {
      const repaymentPath = `${path}.credit.repayments[${repaymentIndex}]`;
      summary.payments.creditRepaymentLinks.count++;
      const matches = order.payments.filter(payment => payment?.repaymentRequestId != null && payment.repaymentRequestId === repayment?.repaymentRequestId);
      if (repayment?.repaymentRequestId == null || matches.length !== 1 || (matches[0].amountCents ?? matches[0].amount) !== (repayment.amountCents ?? repayment.amount) || matches[0].method !== repayment.method || matches[0].chargeId !== 'credit-repayment' || (repayment.time != null && matches[0].time !== repayment.time)) {
        addIssue(ambiguities, 'CREDIT_REPAYMENT_LINK_AMBIGUOUS', repaymentPath, '回款与原付款不能唯一核对，不能重复计入资金');
      } else {
        summary.payments.creditRepaymentLinks.matched++;
      }
    }
  }
  summary.payments.byChannel = [...channels.values()].sort((a, b) => a.method.localeCompare(b.method, 'zh-CN'));
  if (summary.payments.missingIds) addIssue(ambiguities, 'PAYMENT_IDS_MISSING', 'orders[*].payments[*].id', `有 ${summary.payments.missingIds} 笔付款缺少稳定编号，正式导入须建立可追映射`);
  if (summary.payments.missingOccurredAt) addIssue(ambiguities, 'PAYMENT_OCCURRED_AT_MISSING', 'orders[*].payments[*].occurredAt', `有 ${summary.payments.missingOccurredAt} 笔付款缺少独立的资金发生时间，不按订单开立时间猜测`);
  if (!Array.isArray(state.processed)) addIssue(ambiguities, 'OPERATION_KEYS_UNKNOWN', 'processed', '原文缺少操作键列表');
  else if (new Set(state.processed).size !== state.processed.length) addIssue(ambiguities, 'OPERATION_KEYS_DUPLICATE', 'processed', '操作键列表有重复项');

  const movements = new Map();
  for (const [index, movement] of state.ledger.entries()) {
    const path = `ledger[${index}]`;
    if (!isObject(movement)) {
      addIssue(errors, 'MOVEMENT_INVALID', path, '库存流水不是对象');
      continue;
    }
    if (movement.productId != null && movement.product != null && movement.productId !== movement.product) {
      addIssue(errors, 'MOVEMENT_PRODUCT_CONFLICT', path, '库存流水商品的新旧字段互相矛盾');
    }
    const productId = movement.productId || movement.product;
    if (typeof productId !== 'string' || !productId) {
      addIssue(errors, 'MOVEMENT_PRODUCT_UNKNOWN', `${path}.product`, '库存流水缺少商品 ID');
      continue;
    }
    const deltaConflict = movement.baseQuantityDelta != null && movement.delta != null && movement.baseQuantityDelta !== movement.delta;
    if (deltaConflict) addIssue(errors, 'MOVEMENT_DELTA_CONFLICT', path, '库存流水数量的新旧字段互相矛盾');
    const delta = deltaConflict ? null : movement.baseQuantityDelta ?? movement.delta;
    if (!Number.isSafeInteger(delta)) addIssue(errors, 'MOVEMENT_DELTA_INVALID', `${path}.delta`, '基础数量变化不是安全整数');
    const row = movements.get(productId) || { productId, counted: 0, uncounted: 0, unknown: 0, countedDelta: 0, uncountedDelta: 0 };
    if (movement.counted === true) {
      summary.inventory.movements.counted++;
      row.counted++;
      if (Number.isSafeInteger(delta)) row.countedDelta += delta;
    } else if (movement.counted === false) {
      summary.inventory.movements.uncounted++;
      row.uncounted++;
      if (Number.isSafeInteger(delta)) row.uncountedDelta += delta;
    } else {
      summary.inventory.movements.unknown++;
      row.unknown++;
      addIssue(ambiguities, 'MOVEMENT_COUNTED_UNKNOWN', `${path}.counted`, '库存流水是否计账未知，不能推算余额');
    }
    movements.set(productId, row);
  }
  summary.inventory.byProduct = [...movements.values()].sort((a, b) => a.productId.localeCompare(b.productId));
  for (const [productId, balance] of Object.entries(state.inventory).sort(([a], [b]) => a.localeCompare(b))) {
    const path = `inventory.${productId}`;
    if (!isObject(balance) || (balance.count !== null && (!Number.isSafeInteger(balance.count) || balance.count < 0))) {
      addIssue(errors, 'INVENTORY_COUNT_INVALID', `${path}.count`, '库存余额必须是 null 或非负安全整数');
      continue;
    }
    if (balance.count === null) summary.inventory.unestablished++;
    if (balance.count === 0) summary.inventory.zero++;
    summary.inventory.balances.push({ productId, count: balance.count, unit: balance.unit ?? null });
    const oldBalance = source.inventory[productId];
    if (isObject(oldBalance) && Object.hasOwn(oldBalance, 'count') && oldBalance.count !== balance.count) {
      addIssue(errors, 'INVENTORY_COUNT_CHANGED', `${path}.count`, '迁移改变了原文库存余额');
    } else if (!oldBalance) {
      addIssue(ambiguities, 'INVENTORY_BALANCE_DEFAULTED', path, '原文没有此商品库存，迁移后仍须实点建账');
    }
    if (isObject(oldBalance) && oldBalance.unit != null && oldBalance.unit !== balance.unit) {
      addIssue(errors, 'INVENTORY_UNIT_CHANGED', `${path}.unit`, '迁移改变了原文库存基础单位');
    } else if (!isObject(oldBalance) || oldBalance.unit == null) {
      addIssue(ambiguities, 'INVENTORY_UNIT_DEFAULTED', `${path}.unit`, '原文没有库存基础单位，不能把当前目录单位当历史事实');
    }
  }

  const statuses = new Map();
  const roomIds = new Set();
  const activeOrderIds = new Set();
  for (const [index, room] of state.rooms.entries()) {
    const path = `rooms[${index}]`;
    if (!isObject(room) || typeof room.id !== 'string' || !room.id || roomIds.has(room.id)) {
      addIssue(errors, 'ROOM_ID_INVALID', `${path}.id`, '房间编号缺失或重复');
      continue;
    }
    roomIds.add(room.id);
    statuses.set(room.status, (statuses.get(room.status) || 0) + 1);
    if (room.order != null) {
      const linkedOrder = ordersById.get(room.order);
      if (!linkedOrder || linkedOrder.kind !== 'room' || linkedOrder.room !== room.id || activeOrderIds.has(room.order)) {
        addIssue(errors, 'ROOM_ORDER_LINK_INVALID', `${path}.order`, '房间指向的营业订单缺失、错配或重复');
      } else {
        activeOrderIds.add(room.order);
        summary.rooms.activeLinks++;
      }
    }
    if (room.status === '营业中' && room.order == null) addIssue(errors, 'ACTIVE_ROOM_WITHOUT_ORDER', path, '营业中房间缺少订单引用');
    if (room.order != null && room.status !== '营业中') addIssue(errors, 'ROOM_STATUS_LINK_MISMATCH', path, '房间指向营业订单但房态不是营业中');
  }
  summary.rooms.byStatus = [...statuses].map(([status, count]) => ({ status, count })).sort((a, b) => String(a.status).localeCompare(String(b.status), 'zh-CN'));
  for (const order of state.orders) {
    if (order?.kind === 'room' && order.status === '营业中' && !activeOrderIds.has(order.id)) {
      addIssue(ambiguities, 'ORPHAN_ACTIVE_ORDER', `orders[${state.orders.indexOf(order)}]`, '营业中旧单未被房间引用；不能自动占用新客房');
    }
  }
  return summary;
}

export function preflightDemoSnapshot(raw) {
  const result = { sourceKey: DEMO_STATE_KEY, sha256: null, rawBytes: null, status: 'error', summary: null, ambiguities: [], errors: [] };
  if (typeof raw !== 'string') {
    addIssue(result.errors, 'RAW_INPUT_REQUIRED', '$', '输入必须是原始 JSON 字符串');
    return finish(result);
  }
  result.sha256 = createHash('sha256').update(raw, 'utf8').digest('hex');
  result.rawBytes = Buffer.byteLength(raw, 'utf8');
  let source;
  try {
    source = JSON.parse(raw);
  } catch {
    addIssue(result.errors, 'JSON_INVALID', '$', '原始 JSON 无法解析，原文必须保持不变');
    return finish(result);
  }
  if (!isObject(source) || source.version !== 1 || !Array.isArray(source.rooms) || !Array.isArray(source.orders) || !Array.isArray(source.ledger) || !isObject(source.inventory)) {
    addIssue(result.errors, 'STRUCTURE_INVALID', '$', '版本或订单、房间、库存、流水核心结构不完整');
    return finish(result);
  }
  if (source.rooms.some(room => !isObject(room)) || source.orders.some(order => !isObject(order))) {
    addIssue(result.errors, 'RECORD_INVALID', '$', '房间或订单含非对象记录');
    return finish(result);
  }
  if (!isObject(source.catalog)) addIssue(result.ambiguities, 'CATALOG_DEFAULTED', 'catalog', '原文未保存运行时目录，迁移只可补当前目录，不能补造历史成交事实');
  let state;
  try {
    const isolated = structuredClone(source);
    validateDemoState(isolated, { checkPackagePrices: false });
    state = normalizeDemoUser(migrateDemoState(migrateStartupState(isolated)));
  } catch {
    addIssue(result.errors, 'MIGRATION_FAILED', '$', '现有迁移链不能安全处理此原文；未写入任何状态');
    return finish(result);
  }
  try {
    result.summary = summarize(source, state, result.ambiguities, result.errors);
  } catch {
    addIssue(result.errors, 'PREFLIGHT_FAILED', '$', '预检无法安全汇总迁移副本；未写入任何状态');
  }
  try {
    validateDemoState(state);
  } catch {
    addIssue(result.errors, 'MIGRATED_STATE_INVALID', '$', '迁移副本未通过现有完整校验，包括套餐价格一致性');
  }
  return finish(result);
}
