/* eslint-disable @typescript-eslint/no-var-requires */
const path = require("path");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const juice = require("juice");

const customCss = `
  .main-wrapper {
    max-width: 37.5rem;
    margin: auto;
  }

  .avatar__intro {
    display: block !important;
  }

  main {
    max-width: 100% !important;
    flex: initial !important;
  }
`;

const unsubscribeFooter = `
<div data-role="module-unsubscribe" class="module" role="module" data-type="unsubscribe" style="color:#444444; font-size:12px; line-height:20px; padding:16px 16px 16px 16px; text-align:Center;" data-muid="4e838cf3-9892-4a6d-94d6-170e474d21e5">
<div class="Unsubscribe--addressLine">
  <p class="Unsubscribe--senderName"
    style="font-size:12px;line-height:10px"
  >
    Incanta
  </p>
  <p style="font-size:12px;line-height:10px">
    <span class="Unsubscribe--senderAddress">{{ address }}</span>
  </p>
</div>
<p style="font-size:12px; line-height:20px;">
  <a class="Unsubscribe--unsubscribeLink" href="{{ unsubscribe_url }}" target="_blank" style="font-family:sans-serif;text-decoration:none;">
    Unsubscribe
  </a>
  -
  <a href="{{ subscriber_preferences_url }}" target="_blank" class="Unsubscribe--unsubscribePreferences" style="font-family:sans-serif;text-decoration:none;">
    Subscriber Preferences
  </a>
</p>
</div>
{{ message_content }}
`;

(async () => {
  if (process.argv.length < 3) {
    const folderNames = fs
      .readdirSync(path.resolve(__dirname, "build", "blog"), {
        withFileTypes: true,
      })
      .filter(file => file.isDirectory())
      .map(file => file.name);

    console.error(
      `Please provide the folder of the built blog post. Options:\n  ${folderNames.join(
        "\n  ",
      )}`,
    );

    process.exit(1);
  }

  const clipboardy = await import("clipboardy");

  const stylesheets = fs.readdirSync(
    path.resolve(__dirname, "build", "assets", "css"),
  );

  const css = fs.readFileSync(
    path.resolve(__dirname, "build", "assets", "css", stylesheets[0]),
    "utf8",
  );

  const blogPostName = process.argv[2];

  const htmlFile = fs.readFileSync(
    path.resolve(__dirname, "build", "blog", blogPostName, "index.html"),
    "utf8",
  );

  const dom = new JSDOM(htmlFile);

  const wrapper = dom.window.document.getElementsByClassName("main-wrapper")[0];

  const headerSpan = wrapper
    .querySelector("header")
    .querySelector(".margin-vert--md");

  headerSpan.innerHTML = `${headerSpan.innerHTML} · <a href="https://checkpointvcs.com/blog/${blogPostName}?ref=newsletter" target="_blank">View in browser</a>`;

  wrapper.querySelector("div>.row>aside").remove();
  wrapper.querySelector("div>.row>div").remove();
  wrapper.querySelector("article").querySelector("footer").remove();
  wrapper.querySelector("main").querySelector("nav").remove();

  const htmlBody = `${wrapper.outerHTML
    .replace(/src="\//g, `src="https://checkpointvcs.com/`)
    .replace(
      /href="\//g,
      `href="https://checkpointvcs.com/`,
    )}${unsubscribeFooter}`;

  const inlineHtml = juice(htmlBody, {
    extraCss: css + customCss,
    preserveFontFaces: false,
    insertPreservedExtraCss: false,
    preserveImportant: true,
  });

  clipboardy.default.write(inlineHtml);
})();
