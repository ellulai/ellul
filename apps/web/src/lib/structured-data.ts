/**
 * JSON-LD builders for the marketing surface. Keep schema shapes in this file;
 * never inline JSON-LD inside page components.
 *
 * Reference: schema.org/Article, schema.org/Organization, schema.org/Product,
 * schema.org/FAQPage, schema.org/BreadcrumbList, schema.org/Blog.
 */

const SITE_URL = "https://ellul.ai";

export interface OrganizationSchema {
  "@context": "https://schema.org";
  "@type": "Organization";
  name: string;
  alternateName: string[];
  url: string;
  logo: string;
  description: string;
  sameAs: string[];
}

export interface WebSiteSchema {
  "@context": "https://schema.org";
  "@type": "WebSite";
  name: string;
  url: string;
  description: string;
  inLanguage: string;
  publisher: { "@type": "Organization"; name: string; url: string };
}

export interface BlogSchema {
  "@context": "https://schema.org";
  "@type": "Blog";
  url: string;
  name: string;
  description: string;
  inLanguage: string;
  publisher: { "@type": "Organization"; name: string; url: string };
  blogPost: BlogPostingRef[];
}

export interface BlogPostingRef {
  "@type": "BlogPosting";
  headline: string;
  url: string;
  datePublished: string;
  dateModified?: string;
  description: string;
}

export interface ItemListSchema {
  "@context": "https://schema.org";
  "@type": "ItemList";
  itemListOrder: "https://schema.org/ItemListOrderAscending" | "https://schema.org/ItemListOrderDescending";
  name: string;
  itemListElement: Array<{
    "@type": "ListItem";
    position: number;
    name: string;
    url?: string;
  }>;
}

export interface ArticleSchema {
  "@context": "https://schema.org";
  "@type": "Article" | "BlogPosting" | "TechArticle";
  headline: string;
  description: string;
  url: string;
  image?: string;
  author: { "@type": "Organization"; name: string; url: string };
  publisher: {
    "@type": "Organization";
    name: string;
    url: string;
    logo: { "@type": "ImageObject"; url: string };
  };
  datePublished: string;
  dateModified?: string;
  mainEntityOfPage: { "@type": "WebPage"; "@id": string };
  articleSection?: string;
  keywords?: string;
  inLanguage?: string;
}

export interface BreadcrumbSchema {
  "@context": "https://schema.org";
  "@type": "BreadcrumbList";
  itemListElement: Array<{
    "@type": "ListItem";
    position: number;
    name: string;
    item: string;
  }>;
}

export interface FaqPageSchema {
  "@context": "https://schema.org";
  "@type": "FAQPage";
  mainEntity: Array<{
    "@type": "Question";
    name: string;
    acceptedAnswer: { "@type": "Answer"; text: string };
  }>;
}

export interface ProductSchema {
  "@context": "https://schema.org";
  "@type": "Product";
  name: string;
  description: string;
  brand: { "@type": "Brand"; name: string };
  offers: OfferSchema[];
}

export interface OfferSchema {
  "@type": "Offer";
  name: string;
  price: string;
  priceCurrency: string;
  url?: string;
  availability?: string;
  priceSpecification?: {
    "@type": "UnitPriceSpecification";
    price: string;
    priceCurrency: string;
    billingDuration: string;
    unitText: string;
  };
}

export function organizationSchema(description: string): OrganizationSchema {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "ellul",
    alternateName: ["Ellul", "ellul.ai", "Ellul Cloud"],
    url: SITE_URL,
    logo: `${SITE_URL}/logo.png`,
    description,
    sameAs: ["https://github.com/joeetdev/ellul.ai-vps"],
  };
}

export function websiteSchema(
  locale: string,
  description: string,
): WebSiteSchema {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "ellul",
    url: SITE_URL,
    description,
    inLanguage: locale,
    publisher: {
      "@type": "Organization",
      name: "ellul",
      url: SITE_URL,
    },
  };
}

export function blogSchema(input: {
  locale: string;
  description: string;
  posts: BlogPostingRef[];
}): BlogSchema {
  return {
    "@context": "https://schema.org",
    "@type": "Blog",
    url: `${SITE_URL}/blog`,
    name: "ellul blog",
    description: input.description,
    inLanguage: input.locale,
    publisher: {
      "@type": "Organization",
      name: "ellul",
      url: SITE_URL,
    },
    blogPost: input.posts,
  };
}

export function blogItemListSchema(
  posts: Array<{ slug: string; title: string }>,
): ItemListSchema {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListOrder: "https://schema.org/ItemListOrderDescending",
    name: "ellul blog posts",
    itemListElement: posts.map((p, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: p.title,
      url: `${SITE_URL}/blog/${p.slug}`,
    })),
  };
}

export function articleSchema(input: {
  headline: string;
  description: string;
  url: string;
  datePublished: string;
  dateModified?: string;
  section?: string;
  keywords?: string;
  locale?: string;
  type?: "Article" | "BlogPosting" | "TechArticle";
  image?: string;
}): ArticleSchema {
  return {
    "@context": "https://schema.org",
    "@type": input.type ?? "BlogPosting",
    headline: input.headline,
    description: input.description,
    url: input.url,
    ...(input.image ? { image: input.image } : {}),
    author: { "@type": "Organization", name: "ellul", url: SITE_URL },
    publisher: {
      "@type": "Organization",
      name: "ellul",
      url: SITE_URL,
      logo: { "@type": "ImageObject", url: `${SITE_URL}/logo.png` },
    },
    datePublished: input.datePublished,
    ...(input.dateModified ? { dateModified: input.dateModified } : {}),
    mainEntityOfPage: { "@type": "WebPage", "@id": input.url },
    ...(input.section ? { articleSection: input.section } : {}),
    ...(input.keywords ? { keywords: input.keywords } : {}),
    ...(input.locale ? { inLanguage: input.locale } : {}),
  };
}

export function breadcrumbSchema(
  items: Array<{ name: string; url: string }>,
): BreadcrumbSchema {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

export function faqPageSchema(
  items: Array<{ q: string; a: string }>,
): FaqPageSchema {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };
}

export function productSchema(input: {
  name: string;
  description: string;
  offers: OfferSchema[];
}): ProductSchema {
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: input.name,
    description: input.description,
    brand: { "@type": "Brand", name: "ellul" },
    offers: input.offers,
  };
}

/**
 * Review schema. Used on /vs/[slug] to publish ellul's head-to-head review
 * of the competitor: itemReviewed = competitor Product, reviewBody = verdict,
 * reviewRating = ellul's score (1-5 scale, derived from feature-matrix
 * advantage tally so it's grounded in the data not arbitrary).
 */
export interface ReviewSchema {
  "@context": "https://schema.org";
  "@type": "Review";
  itemReviewed: {
    "@type": "Product" | "SoftwareApplication";
    name: string;
    url: string;
    brand?: { "@type": "Brand"; name: string };
    description?: string;
  };
  reviewBody: string;
  name: string;
  url: string;
  datePublished: string;
  dateModified?: string;
  author: { "@type": "Organization"; name: string; url: string };
  publisher: { "@type": "Organization"; name: string; url: string };
  reviewRating: {
    "@type": "Rating";
    ratingValue: string;
    bestRating: string;
    worstRating: string;
  };
  positiveNotes?: { "@type": "ItemList"; itemListElement: Array<{ "@type": "ListItem"; position: number; name: string }> };
  negativeNotes?: { "@type": "ItemList"; itemListElement: Array<{ "@type": "ListItem"; position: number; name: string }> };
}

export function reviewSchema(input: {
  itemName: string;
  itemUrl: string;
  itemDescription?: string;
  reviewBody: string;
  reviewName: string;
  reviewUrl: string;
  datePublished: string;
  dateModified?: string;
  ratingValue: number;
  positives?: string[];
  negatives?: string[];
}): ReviewSchema {
  return {
    "@context": "https://schema.org",
    "@type": "Review",
    itemReviewed: {
      "@type": "SoftwareApplication",
      name: input.itemName,
      url: input.itemUrl,
      brand: { "@type": "Brand", name: input.itemName },
      ...(input.itemDescription
        ? { description: input.itemDescription }
        : {}),
    },
    reviewBody: input.reviewBody,
    name: input.reviewName,
    url: input.reviewUrl,
    datePublished: input.datePublished,
    ...(input.dateModified ? { dateModified: input.dateModified } : {}),
    author: { "@type": "Organization", name: "ellul", url: SITE_URL },
    publisher: { "@type": "Organization", name: "ellul", url: SITE_URL },
    reviewRating: {
      "@type": "Rating",
      ratingValue: input.ratingValue.toFixed(1),
      bestRating: "5.0",
      worstRating: "1.0",
    },
    ...(input.positives?.length
      ? {
          positiveNotes: {
            "@type": "ItemList",
            itemListElement: input.positives.map((p, i) => ({
              "@type": "ListItem" as const,
              position: i + 1,
              name: p,
            })),
          },
        }
      : {}),
    ...(input.negatives?.length
      ? {
          negativeNotes: {
            "@type": "ItemList",
            itemListElement: input.negatives.map((n, i) => ({
              "@type": "ListItem" as const,
              position: i + 1,
              name: n,
            })),
          },
        }
      : {}),
  };
}

export interface HowToStepSchema {
  "@type": "HowToStep";
  position: number;
  name: string;
  text: string;
  url?: string;
}

export interface HowToSchema {
  "@context": "https://schema.org";
  "@type": "HowTo";
  name: string;
  description: string;
  url: string;
  datePublished: string;
  dateModified?: string;
  step?: HowToStepSchema[];
  totalTime?: string;
}

export function howToSchema(input: {
  name: string;
  description: string;
  url: string;
  datePublished: string;
  dateModified?: string;
  steps?: Array<{ name: string; text: string; url?: string }>;
  totalTime?: string;
}): HowToSchema {
  return {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: input.name,
    description: input.description,
    url: input.url,
    datePublished: input.datePublished,
    ...(input.dateModified ? { dateModified: input.dateModified } : {}),
    ...(input.totalTime ? { totalTime: input.totalTime } : {}),
    ...(input.steps?.length
      ? {
          step: input.steps.map((s, i) => ({
            "@type": "HowToStep" as const,
            position: i + 1,
            name: s.name,
            text: s.text,
            ...(s.url ? { url: s.url } : {}),
          })),
        }
      : {}),
  };
}

export interface PersonSchema {
  "@context": "https://schema.org";
  "@type": "Person";
  name: string;
  description?: string;
  url?: string;
  image?: string;
  jobTitle?: string;
  sameAs?: string[];
  worksFor?: { "@type": "Organization"; name: string; url: string };
}

export function personSchema(input: {
  name: string;
  description?: string;
  url?: string;
  image?: string;
  jobTitle?: string;
  sameAs?: string[];
}): PersonSchema {
  return {
    "@context": "https://schema.org",
    "@type": "Person",
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    ...(input.url ? { url: input.url } : {}),
    ...(input.image ? { image: input.image } : {}),
    ...(input.jobTitle ? { jobTitle: input.jobTitle } : {}),
    ...(input.sameAs?.length ? { sameAs: input.sameAs } : {}),
    worksFor: { "@type": "Organization", name: "ellul", url: SITE_URL },
  };
}

export interface DefinedTermSchema {
  "@context": "https://schema.org";
  "@type": "DefinedTerm";
  "@id": string;
  name: string;
  description: string;
  url: string;
  termCode?: string;
  inDefinedTermSet?: { "@type": "DefinedTermSet"; "@id": string; name: string };
  alternateName?: string[];
  dateModified?: string;
}

export function definedTermSchema(input: {
  slug: string;
  name: string;
  description: string;
  url: string;
  setUrl?: string;
  setName?: string;
  alternateName?: string[];
  dateModified?: string;
}): DefinedTermSchema {
  return {
    "@context": "https://schema.org",
    "@type": "DefinedTerm",
    "@id": input.url,
    name: input.name,
    description: input.description,
    url: input.url,
    termCode: input.slug,
    ...(input.setUrl
      ? {
          inDefinedTermSet: {
            "@type": "DefinedTermSet",
            "@id": input.setUrl,
            name: input.setName ?? "ellul glossary",
          },
        }
      : {}),
    ...(input.alternateName?.length
      ? { alternateName: input.alternateName }
      : {}),
    ...(input.dateModified ? { dateModified: input.dateModified } : {}),
  };
}

export interface DefinedTermSetSchema {
  "@context": "https://schema.org";
  "@type": "DefinedTermSet";
  "@id": string;
  name: string;
  description: string;
  url: string;
  hasDefinedTerm: Array<{
    "@type": "DefinedTerm";
    "@id": string;
    name: string;
    url: string;
  }>;
}

export function definedTermSetSchema(input: {
  url: string;
  name: string;
  description: string;
  terms: Array<{ slug: string; term: string; href: string }>;
}): DefinedTermSetSchema {
  return {
    "@context": "https://schema.org",
    "@type": "DefinedTermSet",
    "@id": input.url,
    name: input.name,
    description: input.description,
    url: input.url,
    hasDefinedTerm: input.terms.map((t) => ({
      "@type": "DefinedTerm" as const,
      "@id": t.href,
      name: t.term,
      url: t.href,
    })),
  };
}

/**
 * Generic ItemList schema for non-blog catalogs (agents, MCP, comparisons,
 * pillars). Use blogItemListSchema for blog index specifically.
 */
export function itemListSchema(input: {
  name: string;
  items: Array<{ name: string; url?: string; description?: string }>;
  order?: "ascending" | "descending";
}): ItemListSchema {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListOrder:
      input.order === "descending"
        ? "https://schema.org/ItemListOrderDescending"
        : "https://schema.org/ItemListOrderAscending",
    name: input.name,
    itemListElement: input.items.map((item, i) => ({
      "@type": "ListItem" as const,
      position: i + 1,
      name: item.name,
      ...(item.url ? { url: item.url } : {}),
    })),
  };
}

export interface SiteNavigationSchema {
  "@context": "https://schema.org";
  "@type": "SiteNavigationElement";
  name: string;
  url: string;
}

export function siteNavigationSchema(
  links: Array<{ name: string; url: string }>,
): SiteNavigationSchema[] {
  return links.map((link) => ({
    "@context": "https://schema.org",
    "@type": "SiteNavigationElement",
    name: link.name,
    url: link.url,
  }));
}

export function tierOffer(input: {
  name: string;
  price: string;
  url?: string;
}): OfferSchema {
  return {
    "@type": "Offer",
    name: input.name,
    price: input.price,
    priceCurrency: "USD",
    availability: "https://schema.org/InStock",
    ...(input.url ? { url: input.url } : {}),
    priceSpecification: {
      "@type": "UnitPriceSpecification",
      price: input.price,
      priceCurrency: "USD",
      billingDuration: "P1M",
      unitText: "month",
    },
  };
}
