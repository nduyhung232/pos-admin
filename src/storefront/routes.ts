/**
 * Storefront & Public Menu routes for "Chè Thong Dong - Tiệm Chè & Đá Bào".
 *
 * Dedicated public path separate from the POS admin:
 *   /menu        - Main public showcase & digital menu (QR-code ready)
 *   /gioi-thieu  - Alias
 *   /cua-hang    - Alias
 *   /tiem-che    - Alias
 *   /api/store/menu - Public JSON endpoint for interactive client-side filtering
 */

import type { Express, Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';

export interface StoreProduct {
  id: number | string;
  name: string;
  price: number;
  category: string;
  description: string;
  image: string;
  badge?: string;
  toppings?: string[];
  isSignature?: boolean;
}

export const SIGNATURE_ITEMS: StoreProduct[] = [
  {
    id: 'sig-1',
    name: 'Chè Bưởi Thốt Nốt Cốt Dừa',
    price: 30000,
    category: 'Chè Truyền Thống',
    description: 'Cùi bưởi giòn sần sật khử đắng kỹ lưỡng, đỗ xanh mềm bùi, đường thốt nốt thơm vàng hòa cùng nước cốt dừa tươi sánh mịn.',
    image: '/images/che_buoi.webp',
    badge: 'Best Seller',
    isSignature: true,
    toppings: ['Nước cốt dừa thêm', 'Dừa non sợi', 'Hạt sen bùi'],
  },
  {
    id: 'sig-2',
    name: 'Chè Khoai Dẻo Thảo Mộc',
    price: 35000,
    category: 'Chè Thảo Mộc',
    description: 'Viên khoai lang vàng, khoai môn tím, khoai matcha dẻo dai tự nhiên, sương sáo Đài Loan mát lành, hạt sen bùi béo và cốt dừa thanh dịu.',
    image: '/images/che_khoai_deo.webp',
    badge: 'Được Yêu Thích',
    isSignature: true,
    toppings: ['Trân châu củ năng', 'Sương sáo', 'Hạt sen bùi'],
  },
  {
    id: 'sig-3',
    name: 'Đá Bào Tuyết Cầu Vồng Trái Cây',
    price: 35000,
    category: 'Đá Bào Tuyết',
    description: 'Tuyết sữa bào mịn như bông gòn tan ngay đầu lưỡi, rưới sốt quả nhiệt đới, xoài chín, mít nghệ, thạch trân châu ngũ sắc.',
    image: '/images/da_bao_tuyet.webp',
    badge: 'Signature',
    isSignature: true,
    toppings: ['Thạch phô mai', 'Trân châu ngọc trai', 'Sữa đặc thêm'],
  },
  {
    id: 'sig-4',
    name: 'Chè Dừa Non Thạch Lá Dứa',
    price: 32000,
    category: 'Chè Truyền Thống',
    description: 'Cơm dừa non mềm dẻo thanh ngọt, thạch lá dứa tươi xanh mát lịm, trân châu sương sa rưới cốt dừa béo bùi ngậy vị.',
    image: '/images/che_dua_non.webp',
    badge: 'Best Seller',
    isSignature: true,
    toppings: ['Dừa non sợi', 'Thạch lá dứa', 'Trân châu đường đen'],
  },
  {
    id: 'sig-5',
    name: 'Trà Sen Vàng Củ Năng Macchiato',
    price: 38000,
    category: 'Trà Trái Cây',
    description: 'Trà ô long thượng hạng ủ lạnh, hạt sen Huế hầm nhừ ngọt bùi, củ năng giòn sần sật, phủ lớp kem macchiato mặn béo.',
    image: '/images/tra_sen_vang.webp',
    badge: 'Món Mới',
    isSignature: true,
    toppings: ['Kem cheese macchiato', 'Củ năng ngâm', 'Hạt sen Huế'],
  },
  {
    id: 'sig-6',
    name: 'Chè Khúc Bạch Hạnh Nhân Sữa',
    price: 35000,
    category: 'Chè Hiện Đại',
    description: 'Khúc bạch phô mai sữa mềm mịn tan biến, nhãn lồng tươi mọng nước, nước đường phèn hoa nhài thanh dịu rắc hạnh nhân lát rang vàng.',
    image: '/images/hero_dessert.webp',
    badge: 'Thanh Mát',
    toppings: ['Hạnh nhân lát', 'Nhãn tươi', 'Khúc bạch thêm'],
  },
  {
    id: 'sig-7',
    name: 'Chè Thái Sầu Riêng Đặc Biệt',
    price: 40000,
    category: 'Chè Hiện Đại',
    description: 'Cơm sầu riêng Ri6 thơm nồng nàn, mít nghệ xắt sợi, thạch ngọc bích, sương sáo, hạt lựu hòa quyện nước cốt dừa béo ngậy.',
    image: '/images/che_buoi.webp',
    badge: 'Đặc Biệt',
    toppings: ['Thịt sầu riêng thêm', 'Trân châu củ năng'],
  },
  {
    id: 'sig-8',
    name: 'Đá Bào Tuyết Xoài Sốt Dừa',
    price: 35000,
    category: 'Đá Bào Tuyết',
    description: 'Lớp đá tuyết mềm mượt rưới đẫm sốt xoài cát Hòa Lộc nguyên chất, thạch dừa giòn sần sật, rưới sữa đặc thơm béo.',
    image: '/images/da_bao_tuyet.webp',
    badge: 'Mát Lạnh',
    toppings: ['Thạch dừa', 'Xoài tươi', 'Kem vanilla'],
  },
  {
    id: 'sig-9',
    name: 'Trà Đào Cam Sả Tươi',
    price: 32000,
    category: 'Trà Trái Cây',
    description: 'Trà đen đậm đà ủ lạnh, đào ngâm giòn ngọt, cam vàng mọng nước cùng hương sả nồng nàn giải nhiệt cực đã.',
    image: '/images/tra_sen_vang.webp',
    badge: 'Giải Nhiệt',
    toppings: ['Đào miếng thêm', 'Hạt chia'],
  },
];

export const TOPPINGS_LIST = [
  { name: 'Trân châu đường đen', price: 5000 },
  { name: 'Trân châu củ năng giòn', price: 6000 },
  { name: 'Thạch lá dứa giòn', price: 5000 },
  { name: 'Sương sáo thảo mộc', price: 5000 },
  { name: 'Hạt sen Huế bùi ngọt', price: 8000 },
  { name: 'Dừa non tươi xắt sợi', price: 7000 },
  { name: 'Kem Macchiato mặn', price: 10000 },
];

function resolveDishImage(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('bưởi') || n.includes('buoi')) return '/images/che_buoi.webp';
  if (n.includes('khoai') || n.includes('thảo mộc') || n.includes('thao moc')) return '/images/che_khoai_deo.webp';
  if (n.includes('bào') || n.includes('bao') || n.includes('tuyết') || n.includes('tuyet')) return '/images/da_bao_tuyet.webp';
  if (n.includes('dừa') || n.includes('dua')) return '/images/che_dua_non.webp';
  if (n.includes('sen') || n.includes('trà') || n.includes('tra') || n.includes('cam') || n.includes('đào')) return '/images/tra_sen_vang.webp';
  return '/images/hero_dessert.webp';
}

export function registerStorefrontRoutes(app: Express, prisma: PrismaClient): void {
  // Store info constants
  const storeInfo = {
    brandName: 'Chè Thong Dong',
    subTitle: 'Tiệm Chè & Đá Bào',
    slogan: 'Thanh mát từng muỗng • Thong dong từng phút giây',
    address: '(Đối diện tòa nhà Đông Á) Số 02A88 Đại Lộ Lê Lợi, Phường Hạc Thành, TP. Thanh Hóa',
    phone: '0357938009',
    phoneDisplay: '0357.938.009',
    zaloUrl: 'https://zalo.me/0357938009',
    googleMapsUrl: 'https://maps.google.com/?q=(%C4%90%E1%BB%91i+di%E1%BB%87n+t%C3%B2a+nh%C3%A0+%C4%90%C3%B4ng+%C3%81)+S%E1%BB%91+02A88+%C4%90%E1%BA%A1i+L%E1%BB%99+L%C3%AA+L%E1%BB%A3i,+Ph%C6%B0%E1%BB%9Dng+H%E1%BA%A1c+Th%C3%A0nh,+Thanh+H%C3%B3a',
    openHours: '09:00 - 22:30',
    daysOpen: 'Mở cửa cả tuần (Thứ 2 - Chủ Nhật)',
    logoPath: '/logo_horizontal.png',
    logoSquarePath: '/logo_icon.png',
  };

  /**
   * Helper to merge DB products with signatures
   */
  async function getMergedProducts(): Promise<{
    products: StoreProduct[];
    categories: string[];
    toppings: typeof TOPPINGS_LIST;
  }> {
    const list: StoreProduct[] = [...SIGNATURE_ITEMS];
    const seenNames = new Set(list.map((p) => p.name.trim().toLowerCase()));

    try {
      const dbProducts = await prisma.product.findMany({
        where: { active: true },
        include: { toppings: { where: { active: true } } },
        orderBy: [{ category: 'asc' }, { name: 'asc' }],
      });

      for (const p of dbProducts) {
        const cleanName = p.name.trim();
        const lower = cleanName.toLowerCase();
        if (seenNames.has(lower)) {
          // Update price from live database if already exists
          const existing = list.find((x) => x.name.trim().toLowerCase() === lower);
          if (existing) {
            existing.price = p.price;
            if (p.toppings && p.toppings.length > 0) {
              existing.toppings = p.toppings.map((t) => t.name);
            }
          }
        } else {
          seenNames.add(lower);
          list.push({
            id: p.id,
            name: cleanName,
            price: p.price,
            category: p.category || 'Món Khác',
            description: `Món ngon đặc sắc tại Chè Thong Dong, chế biến tươi mới hàng ngày chuẩn vị thanh mát.`,
            image: resolveDishImage(cleanName),
            toppings: p.toppings?.map((t) => t.name) || ['Nước cốt dừa', 'Trân châu'],
          });
        }
      }
    } catch (e) {
      console.warn('Storefront: could not fetch db products, using default signatures:', e);
    }

    const categories = Array.from(new Set(list.map((p) => p.category)));

    return {
      products: list,
      categories,
      toppings: TOPPINGS_LIST,
    };
  }

  // Showcase handler
  const renderStorefront = async (_req: Request, res: Response) => {
    // Cache for 60s, stale-while-revalidate for 5 minutes for lightning performance
    res.set({
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
    });

    const { products, categories, toppings } = await getMergedProducts();

    res.render('storefront', {
      storeInfo,
      products,
      categories,
      toppings,
    });
  };

  // Register dedicated storefront paths
  app.get('/menu', renderStorefront);
  app.get('/gioi-thieu', renderStorefront);
  app.get('/cua-hang', renderStorefront);
  app.get('/tiem-che', renderStorefront);

  // Dedicated JSON API for instant client-side searching / category tab filtering
  app.get('/api/store/menu', async (_req: Request, res: Response) => {
    res.set('Cache-Control', 'public, max-age=60');
    const data = await getMergedProducts();
    res.json({
      store: storeInfo,
      ...data,
    });
  });
}
