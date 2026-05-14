export interface ImageProps {
  src: string;
  alt: string;
  caption?: string;
  width?: number;
  height?: number;
}

export function Image({ src, alt, caption, width, height }: ImageProps) {
  return (
    <figure className="my-8">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        width={width}
        height={height}
        className="rounded-2xl border border-cream/[0.06]"
      />
      {caption && (
        <figcaption className="mt-2 text-center text-xs text-cream/45">
          {caption}
        </figcaption>
      )}
    </figure>
  );
}
