/**
 * JSON-LD builders for the docs surface. Keep schema shapes in this file —
 * never inline JSON-LD inside page components.
 *
 * Reference: schema.org/TechArticle, schema.org/Organization, schema.org/WebSite.
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

export interface TechArticleSchema {
  "@context": "https://schema.org";
  "@type": "TechArticle";
  headline: string;
  description: string;
  url: string;
  datePublished?: string;
  dateModified?: string;
  author: { "@type": "Organization"; name: string; url: string };
  publisher: {
    "@type": "Organization";
    name: string;
    url: string;
    logo: { "@type": "ImageObject"; url: string };
  };
  mainEntityOfPage: { "@type": "WebPage"; "@id": string };
  articleSection?: string;
  audience?: { "@type": "Audience"; audienceType: string };
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
  url: string,
  name = "ellul",
): WebSiteSchema {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name,
    url,
    description,
    inLanguage: locale,
    publisher: {
      "@type": "Organization",
      name: "ellul",
      url: SITE_URL,
    },
  };
}

export function techArticleSchema(input: {
  headline: string;
  description: string;
  url: string;
  datePublished?: string;
  dateModified?: string;
  section?: string;
}): TechArticleSchema {
  return {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: input.headline,
    description: input.description,
    url: input.url,
    ...(input.datePublished ? { datePublished: input.datePublished } : {}),
    ...(input.dateModified ? { dateModified: input.dateModified } : {}),
    author: { "@type": "Organization", name: "ellul", url: SITE_URL },
    publisher: {
      "@type": "Organization",
      name: "ellul",
      url: SITE_URL,
      logo: { "@type": "ImageObject", url: `${SITE_URL}/logo.png` },
    },
    mainEntityOfPage: { "@type": "WebPage", "@id": input.url },
    ...(input.section ? { articleSection: input.section } : {}),
    audience: { "@type": "Audience", audienceType: "Developers" },
  };
}
