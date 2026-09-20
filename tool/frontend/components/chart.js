import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";

export function renderBarChart(svg, data, opts = {}) {
  const width  = (opts.width ?? +svg.getAttribute("width")) || 900;
  const height = (opts.height ?? +svg.getAttribute("height")) || 420;
  const title  = opts.title ?? "";

  // Reset
  const root = d3.select(svg);
  root.attr("width", width).attr("height", height);
  root.selectAll("*").remove();

  const m = { top: 28, right: 20, bottom: 44, left: 48 };
  const innerW = width - m.left - m.right;
  const innerH = height - m.top - m.bottom;

  const g = root.append("g").attr("transform", `translate(${m.left},${m.top})`);

  // Scales
  const x = d3.scaleBand()
    .domain(data.map(d => d.name))
    .range([0, innerW])
    .padding(0.2);

  const y = d3.scaleLinear()
    .domain([0, d3.max(data, d => d.value) || 0]).nice()
    .range([innerH, 0]);

  // Gridlines
  g.append("g")
    .attr("class", "grid")
    .selectAll("line")
    .data(y.ticks(5))
    .join("line")
      .attr("x1", 0)
      .attr("x2", innerW)
      .attr("y1", d => y(d))
      .attr("y2", d => y(d))
      .attr("stroke", "#e5e7eb");

  // Bars (with a smooth transition)
  g.selectAll("rect.bar")
    .data(data, d => d.name)
    .join(
      enter => enter.append("rect")
        .attr("class", "bar")
        .attr("x", d => x(d.name))
        .attr("y", innerH)
        .attr("width", x.bandwidth())
        .attr("height", 0)
        .attr("fill", "#3b82f6")
        .attr("rx", 4)
        .call(sel => sel.append("title").text(d => `${d.name}: ${d.value}`))
        .transition().duration(700)
          .attr("y", d => y(d.value))
          .attr("height", d => innerH - y(d.value)),
      update => update
        .transition().duration(500)
          .attr("x", d => x(d.name))
          .attr("width", x.bandwidth())
          .attr("y", d => y(d.value))
          .attr("height", d => innerH - y(d.value)),
      exit => exit.transition().duration(400)
          .attr("y", innerH)
          .attr("height", 0)
          .remove()
    );

  // Axes rendered in a lightweight manner
  // X axis
  g.append("g")
    .attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(x).tickSizeOuter(0))
    .selectAll("text")
      .attr("font-size", 12)
      .attr("fill", "#374151");

  // Y axis
  g.append("g")
    .call(d3.axisLeft(y).ticks(5))
    .selectAll("text")
      .attr("font-size", 12)
      .attr("fill", "#374151");

  // Title
  if (title) {
    g.append("text")
      .attr("x", 0)
      .attr("y", -10)
      .attr("font-weight", 600)
      .attr("fill", "#111827")
      .text(title);
  }
}

export function resizeToParent(svg, wrapper, { min = 600, max = 1200, height = 420 } = {}) {
  const w = Math.max(min, Math.min(wrapper.clientWidth || min, max));
  svg.setAttribute("width", w);
  svg.setAttribute("height", height);
  return w;
}
