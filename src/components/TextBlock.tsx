type Props = {
  text: string;
  lang?: string | null;
  className?: string;
  as?: "p" | "span" | "h2" | "h3";
};

const BCP47 = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/;

export function TextBlock({ text, lang, className, as: Tag = "p" }: Props) {
  const safeLang = lang && BCP47.test(lang) ? lang : undefined;
  return (
    <Tag
      className={className}
      dir="auto"
      style={{ unicodeBidi: "isolate" }}
      {...(safeLang ? { lang: safeLang } : {})}
    >
      {text}
    </Tag>
  );
}
