"""Conservative structure-only protection detection. Executes no site JavaScript."""
from html.parser import HTMLParser


class Markup(HTMLParser):
    def __init__(self):
        super().__init__()
        self.protected = False
        self.interactive = False
        self.text = []

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        self.protected |= attrs.get("id") == "sec-if-cpt-container" or attrs.get("name") == "sec_sbsd_chlge_form"
        self.interactive |= bool(set(attrs.get("class", "").split()) & {"g-recaptcha", "h-captcha"})
        if self.protected and tag in {"button", "iframe", "select", "textarea"}:
            self.interactive = True

    def handle_data(self, text):
        self.text.append(text)


def document_kind(body):
    markup = Markup()
    markup.feed(body.decode("utf-8", errors="replace"))
    text = " ".join(markup.text).lower()
    if markup.interactive or "verify you are human" in text or "verify that you are human" in text:
        return "interactive_challenge"
    return "protection" if markup.protected else "document"
